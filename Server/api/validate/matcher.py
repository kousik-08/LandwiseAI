import os
import re
import shutil
import uuid
from pathlib import Path
from typing import List, Dict, Optional
import json
from datetime import datetime

# EC dates appear in many shapes ("27/02/2024", "27-Feb-2024", "27.02.2024",
# "2024-02-27", "27 February 2024", etc.) because Gemini OCRs whatever the
# registry office's stamp uses. The "last N transactions" feature broke
# when only "%d-%b-%Y" was supported — every other shape parsed as
# datetime.min, all tied → Python's stable sort returned them in Gemini's
# emission order, looking random to the user.
_EC_DATE_FORMATS = (
    "%d-%b-%Y",   # 27-Feb-2024
    "%d-%B-%Y",   # 27-February-2024
    "%d/%b/%Y",   # 27/Feb/2024
    "%d/%B/%Y",   # 27/February/2024
    "%d %b %Y",   # 27 Feb 2024
    "%d %B %Y",   # 27 February 2024
    "%d-%m-%Y",   # 27-02-2024
    "%d/%m/%Y",   # 27/02/2024
    "%d.%m.%Y",   # 27.02.2024
    "%Y-%m-%d",   # 2024-02-27
    "%Y/%m/%d",   # 2024/02/27
    "%b %d, %Y",  # Feb 27, 2024
    "%B %d, %Y",  # February 27, 2024
    "%d-%m-%y",   # 27-02-24
    "%d/%m/%y",   # 27/02/24
)

try:
    from dateutil.parser import parse as _dateutil_parse  # type: ignore
except Exception:
    _dateutil_parse = None


def _parse_ec_date(raw: str) -> datetime:
    """
    Robust EC-date parser. Tries the most common TN registry formats first,
    then falls back to dateutil (dayfirst=True — Indian date convention).
    Returns datetime.min for empty / 'N/A' / genuinely unparseable input.

    Multi-date support: the v6 EC RAW_PROMPT instructs the LLM to emit every
    date in the EC's date column (execution / registration / completion),
    pipe-separated like "20-Jul-2018 | 20-Jul-2018 | 31-Jul-2018". For sort
    purposes we anchor on the first parseable token — that's the execution
    date the deed's body narrative also carries, and it's what the EC's own
    "Date of Registration" anchor uses. Without this split, every multi-date
    string fell through to datetime.min and "last N" collapsed to EC
    emission order (which happens to lead with the oldest transactions).
    """
    if not raw:
        return datetime.min
    s = str(raw).strip().strip(".,;")
    if not s or s.upper() in {"N/A", "NA", "NONE", "MISSING", "NOT AVAILABLE", "-"}:
        return datetime.min

    # Multi-date column: the v6 EC RAW_PROMPT emits multiple dates separated
    # by " | " (execution / registration / completion). Older shapes
    # occasionally use " / ". Comma is NOT a multi-date separator — it
    # already lives inside single dates like "Jul 20, 2018".
    # Take the first parseable token; that's the execution date.
    for sep in (" | ", "|", " / "):
        if sep in s:
            for tok in (t.strip() for t in s.split(sep)):
                if not tok:
                    continue
                dt = _parse_ec_date(tok)
                if dt != datetime.min:
                    return dt
            break  # tried this separator; no token parsed

    for fmt in _EC_DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue

    if _dateutil_parse is not None:
        try:
            return _dateutil_parse(s, dayfirst=True, fuzzy=True)
        except (ValueError, TypeError, OverflowError):
            pass

    # One-time logging: a sample of unparseable dates surfaces the format we
    # need to add to _EC_DATE_FORMATS rather than silently sorting it to min.
    print(f"[matcher] Unparseable EC date: {raw!r} — treating as oldest")
    return datetime.min


class DocumentMatcher:
    """
    Matches document numbers from EC JSON with local PDF files and manages workspace.
    """

    def __init__(
        self,
        docs_dir: str,
        output_base: str = "tmp",
        process_id: Optional[str] = None,
        keep_workspace: bool = False,
    ):
        self.docs_dir = Path(docs_dir)
        # If a process_id is supplied, we create a workspace subfolder under output_base.
        # If process_id is None, output_base is treated as the full workspace path.
        self.process_id = process_id or str(uuid.uuid4())[:8]
        self.workspace = Path(output_base) if process_id is None else (Path(output_base) / self.process_id)
        self.keep_workspace = keep_workspace
        os.makedirs(self.workspace, exist_ok=True)
        # Side-channel telemetry from the last load_and_match() call. Lets the
        # handler emit a UI-visible warning when "last N" had to dig past
        # newer EC transactions whose PDFs weren't in the upload — otherwise
        # the user sees an old slice (e.g. 1990–2011) when the EC actually
        # has 2018–2024 transactions, with no explanation.
        self.last_skipped_no_pdf: list[dict] = []
        self.last_total_ec_entries: int = 0
        print(f"[*] Workspace created: {self.workspace}")

    def _normalize_doc_no(self, doc_no: str) -> str:
        """Deep normalization for robust document number matching."""
        if not doc_no or doc_no == "N/A": return ""
        # Remove all whitespace, lowercase, and convert separators to underscore
        norm = str(doc_no).strip().lower()
        norm = re.sub(r'[\s\-/]', '_', norm) # Replace space, hyphen, slash with underscore
        norm = re.sub(r'_+', '_', norm)      # Collapse multiple underscores
        return norm

    @staticmethod
    def _candidate_keys(doc_no: str, date_str: str | None) -> list[str]:
        """
        Build candidate normalized keys for matching an EC doc_no to a PDF
        filename.

        Two real-world quirks this handles:

        1. Gemini sometimes extracts the EC's doc_no as a bare serial
           ("266", "97", "284") even though the PDFs are uniformly named
           "<serial>_<year>.pdf" ("266_2009.pdf", "284_2016.pdf").

           Fix: if doc_no has no year already, derive one from the EC
           entry's date and add "<doc>_<year>" as an alternate key.

        2. The reverse — doc_no is "266/2009" but a PDF might be named
           bare "266.pdf". Add the bare-numeric stem as a fallback.

        The caller tries each key in order; first hit wins.
        """
        if not doc_no or doc_no == "N/A":
            return []
        base = str(doc_no).strip().lower()
        base = re.sub(r"[\s\-/]", "_", base)
        base = re.sub(r"_+", "_", base)

        keys: list[str] = [base]

        # Already has _YYYY suffix?
        has_year = bool(re.search(r"_\d{4}$", base))

        if not has_year:
            # Derive year from the date string (matcher's robust parser).
            year = None
            try:
                from datetime import datetime  # local — avoid cycle
                dt = _parse_ec_date(date_str or "")
                if dt and dt != datetime.min:
                    year = dt.year
            except Exception:
                year = None
            if year:
                keys.append(f"{base}_{year}")

        # Fallback: bare prefix stripped of trailing _YYYY
        bare = re.sub(r"_\d{4}$", "", base)
        if bare != base:
            keys.append(bare)

        # Dedupe, preserve order
        seen = set()
        out = []
        for k in keys:
            if k and k not in seen:
                seen.add(k)
                out.append(k)
        return out

    def match_documents(
        self, ec_data: List[Dict], limit: Optional[int] = None
    ) -> List[Dict[str, str]]:
        """
        Matches the provided EC entries with local PDF files.
        """
        if not self.docs_dir.exists():
            raise FileNotFoundError(f"Docs directory {self.docs_dir} not found.")

        existing_files = os.listdir(self.docs_dir)
        # Create a map of normalized_filename -> actual_filename for quick lookup
        file_map = {}
        for f in existing_files:
            if f.lower().endswith(".pdf"):
                norm_f = self._normalize_doc_no(os.path.splitext(f)[0])
                file_map[norm_f] = f

        matches = []
        for entry in ec_data:
            doc_no = entry.get("document_number", "")
            if not doc_no or doc_no == "N/A":
                continue

            # Normalized target
            norm_target = self._normalize_doc_no(doc_no)
            
            # Match directly from normalized map
            matched_file = file_map.get(norm_target)

            if matched_file:
                src = self.docs_dir / matched_file
                dest = self.workspace / matched_file
                shutil.copy2(src, dest)
                matches.append({"document_number": doc_no, "file_path": str(dest)})
                print(f"[OK] Matched: {doc_no} -> {matched_file}")
        
        return matches

    def load_and_match(self, json_path: str, limit: Optional[int] = None) -> List[Dict[str, str]]:
        """
        Reads EC data from JSON and matches the most recent 'limit' documents that have files.
        If a document is a duplicate or missing its file, it skips it and looks for the next previous one.
        """
        if not os.path.exists(json_path):
            raise FileNotFoundError(f"EC data file not found: {json_path}")

        with open(json_path, "r", encoding="utf-8") as f:
            ec_data = json.load(f)

        # Defensive: accept both legacy [...] and the (briefly used) envelope
        # form {"_v": N, "data": [...]}. Production format is the bare list,
        # but any ec_final.json written by a buggy intermediate build needs
        # to keep working without manual cleanup.
        if isinstance(ec_data, dict) and isinstance(ec_data.get("data"), list):
            ec_data = ec_data["data"]
        if not isinstance(ec_data, list):
            raise ValueError(
                f"EC data file {json_path} is not a list of transactions "
                f"(got {type(ec_data).__name__}). Re-run analysis to rebuild it."
            )

        # 1. Sort data by date (newest to oldest). Uses the multi-format
        # parser so registry-stamp variations (DD/MM/YYYY, ISO, full month
        # name, etc.) don't all collapse to datetime.min and ruin "last N".
        ec_data.sort(key=lambda e: _parse_ec_date(e.get("date", "")), reverse=True)

        # 2. Setup file mapping for quick lookups
        if not self.docs_dir.exists():
            raise FileNotFoundError(f"Docs directory {self.docs_dir} not found.")

        existing_files = os.listdir(self.docs_dir)
        file_map = {}
        for f in existing_files:
            if f.lower().endswith(".pdf"):
                norm_f = self._normalize_doc_no(os.path.splitext(f)[0])
                file_map[norm_f] = f

        # 3. Determine actual limit
        # 0 or None means process ALL documents (unlimited)
        if limit is None or limit < 0:
            effective_limit = 0  # 0 = unlimited, process all documents
        else:
            effective_limit = limit
        
        # 4. Iterate and fill the matches list
        seen_docs = set()
        matches = []
        # Track docs that appear NEWER than the oldest selected match but were
        # skipped because their PDF wasn't in the upload zip. Surfaced at the
        # end so the user understands WHY they got an older slice than they
        # expected (e.g. "last 5" returned 2009 docs when the EC actually
        # extends to 2016 — the missing 2010-2016 PDFs were skipped).
        skipped_no_pdf: list[dict] = []

        target_desc = f"{effective_limit} unique" if effective_limit > 0 else "all"
        print(f"[*] Searching history to fill quota of {target_desc} matched transactions...")

        for entry in ec_data:
            doc_no = entry.get("document_number")
            if not doc_no or doc_no == "N/A":
                continue

            norm_doc = self._normalize_doc_no(doc_no)

            # Skip if already seen (deduplication)
            if norm_doc in seen_docs:
                continue
            seen_docs.add(norm_doc)

            # Try every plausible filename variant for this EC entry.
            # The EC's date is the disambiguator: bare-number doc_nos
            # like "266" get an alternate "266_<year>" key derived from
            # the entry's date, which is how the PDFs are actually named.
            candidates = self._candidate_keys(doc_no, entry.get("date"))
            matched_file = None
            for key in candidates:
                hit = file_map.get(key)
                if hit:
                    matched_file = hit
                    break
            if matched_file:
                # File exists! Copy and add to matches
                src = self.docs_dir / matched_file
                dest = self.workspace / matched_file
                shutil.copy2(src, dest)

                matches.append({
                    "document_number": doc_no,
                    "file_path": str(dest),
                    "date": entry.get("date")
                })
                print(f"[OK] Matched [{len(matches)}]: {doc_no} ({entry.get('date', 'N/A')})")

                # Check if we hit our limit
                if effective_limit > 0 and len(matches) >= effective_limit:
                    break
            else:
                # No PDF for this doc in the upload — log it.
                # When `limit` is in effect (last-N), every record here is
                # newer than any subsequent match (we iterate newest-first),
                # so listing them tells the user EXACTLY which transactions
                # would have been picked if the corresponding PDFs were
                # included in the zip.
                skipped_no_pdf.append({
                    "document_number": doc_no,
                    "date": entry.get("date") or "N/A",
                })

        # 5. Loud, actionable summary when the user asked for last-N but
        # we had to dig past missing PDFs to fill the quota. The first N
        # entries of skipped_no_pdf are the docs that WOULD have been
        # selected if their PDFs were present.
        if effective_limit > 0 and skipped_no_pdf:
            n_show = min(len(skipped_no_pdf), effective_limit * 2)
            print(
                f"[!] {len(skipped_no_pdf)} EC transaction(s) newer than your selection "
                f"were skipped because no matching PDF was found in the upload."
            )
            print(
                f"    The first {n_show} skipped (newest first) — include these PDFs "
                f"in your deed zip to see them in 'last {effective_limit}':"
            )
            for s in skipped_no_pdf[:n_show]:
                print(f"      - {s['document_number']:15} ({s['date']})")

        # 6. Reverse matches so they are chronological (oldest to newest) for the rest of the workflow
        matches.reverse()

        # 7. Stash the skip telemetry so the handler can surface it as a
        # user-visible warning. Without this, the user sees an old slice
        # of the EC and has no idea WHY their "last 20" returned 1990s docs.
        self.last_skipped_no_pdf = skipped_no_pdf
        self.last_total_ec_entries = len(ec_data)

        print(f"[*] Successfully matched {len(matches)} documents.")
        return matches

    def cleanup(self):
        """
        Removes the temporary workspace.
        """
        if self.keep_workspace:
            return
        if self.workspace.exists():
            shutil.rmtree(self.workspace)
            print(f"[*] Workspace {self.workspace} cleaned up.")
