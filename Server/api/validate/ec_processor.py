import os
import re
import json
import fitz # PyMuPDF
from typing import List, Dict, Any
from pypdf import PdfReader
from common.gemini_helper import GeminiHelper
from prompts.ec_prompts import RAW_PROMPT
from prompts.ec_analysis_prompts import EC_ANALYSIS_PROMPT


class ECProcessor:
    """
    Handles extraction and parsing of Encumbrance Certificate (EC) data.
    """

    # Bump when the parser schema changes so stale ec_final.json caches
    # don't poison new runs (e.g. when we add the bare-doc-no year-backfill
    # in parse_to_json — see _backfill_doc_year).
    #
    # v9: each transaction now carries ec_page_start / ec_page_end (the EC page
    #     range it was extracted from) so the EC visual debugger can scope its
    #     search to the right page(s) instead of scanning the whole EC.
    # v10: ec_page_start == ec_page_end == the SINGLE page the transaction sits
    #      on (resolved from Gemini's per-transaction `Page:` field), instead of
    #      the whole chunk span. With chunk_size 8-20 the old span made the EC
    #      debugger scan up to 20 pages; a single page makes it scan one.
    _PARSE_VERSION = 10

    # Bump when the Gemini RAW_PROMPT changes. The raw OCR cache
    # (ec_raw_full.txt) carries this marker at the top; a mismatch forces
    # a fresh Gemini run instead of reusing OCR output captured under an
    # older prompt. Without this, prompt fixes never reach existing
    # parcels because the raw text cache silently wins.
    #
    # v3: reverted to Beta-version RAW_PROMPT per user request.
    # v4: extended Beta prompt with transaction-scoped extent guard +
    #     seller/buyer name-vs-title extraction + POA agent/principal
    #     surfacing. Fixes extent picked from referenced parent transaction
    #     and "முதல்வர்" placeholders that dropped real names.
    # v5: schedule-block binding rule (each Schedule belongs to the
    #     transaction header IMMEDIATELY ABOVE it; never bleeds to the
    #     next transaction). Multi-date emission instead of picking one.
    #     Also drives the gemini-3.5-flash upgrade — re-OCR everything.
    # v6: universalized the rules — explicit "applies to every transaction
    #     in every EC" framing, parent-doc citation rule, multi-date column
    #     rule, extent-unit + survey-no fidelity, name-vs-title detection
    #     triggers, and a mandatory per-transaction self-check (Extent /
    #     Survey / Plot must come from THIS transaction's schedule).
    # v7: locked the multi-date Date field to a strict pipe-only format
    #     ("DD-Mon-YYYY | DD-Mon-YYYY | ...") with explicit forbidden-format
    #     examples. Necessary because the LLM occasionally drifted to
    #     newline / comma / annotation variants under v6, which all
    #     downstream date sorters parse as "oldest" — collapsing "last N"
    #     into EC emission order and surfacing the wrong slice.
    # v8: stronger row-binding for the schedule extraction bug that kept
    #     re-appearing on 5550/2013 (and similar). Added rule B3 (the
    #     leftmost serial number is the AUTHORITATIVE row boundary) and
    #     B4 (cross-check extent against the Schedule Remarks prose at the
    #     bottom of the same row's block before emitting). Reframed the
    #     anti-shift rule to match the actual downward-bleed direction.
    # v9: raw OCR text now carries per-chunk "### EC_PAGE start=S end=E ###"
    #     markers so parse_to_json can stamp each transaction with its EC page
    #     range. Existing caches lack the markers, so bump to force a re-OCR.
    # v10: RAW_PROMPT now emits a per-transaction `Page:` field (1-based page
    #      within the chunk) so each transaction resolves to a SINGLE EC page.
    #      Existing caches lack the field, so bump to force a re-OCR.
    _OCR_VERSION = 10
    _OCR_HEADER_RE = re.compile(r"^#\s*OCR_VERSION=(\d+)\s*\n")

    def __init__(self, output_dir: str = "outputs", chunk_size: int = 5):
        self.output_dir = output_dir
        self.chunk_size = chunk_size
        self.gemini = GeminiHelper(model_id="gemini-3.5-flash")
        os.makedirs(self.output_dir, exist_ok=True)

    # Set of label tokens (without trailing colon) Gemini emits when it
    # collapses a missing-value line into the next label — e.g. for doc
    # 257/2009 we saw  Sellers: Buyers:  on one line, which the old parser
    # happily stored as sellers=["Buyers:"]. Used by both _extract_field
    # and _split_names to reject contaminated values.
    _KNOWN_LABEL_TOKENS = (
        "document no",
        "date",
        "sellers",
        "buyers",
        "survey no",
        "nature of the land",
        "nature of document",
        "extent",
        "consideration",
        "market value",
    )

    @classmethod
    def _value_is_just_a_label(cls, value: str) -> bool:
        """True when the captured value is in fact another field's label —
        i.e., Gemini collapsed a blank line into the next one."""
        if not value:
            return False
        v = value.strip().rstrip(":").strip().lower()
        return v in cls._KNOWN_LABEL_TOKENS

    def _extract_field(self, block: str, field: str) -> str:
        # Anchor to start-of-line (re.M) so a label appearing mid-line as a
        # NEXT field's value cannot match here. Use [ \t]* (not \s*) around
        # the colon so the regex never eats a newline — that's how the old
        # parser captured the SURVEY-NO line as the value of an empty
        # Buyers field, producing buyers=["Survey No: 45/4", ...].
        m = re.search(
            rf"^{re.escape(field)}[ \t]*:[ \t]*(.*)",
            block,
            re.IGNORECASE | re.MULTILINE,
        )
        if not m:
            return "N/A"
        value = m.group(1).strip()
        # If Gemini wrote "Sellers: Buyers:" on one line, "Buyers:" is not a
        # value for Sellers — it's the next label. Normalize to N/A so
        # downstream parsing (and the matcher) treat the field as missing.
        if self._value_is_just_a_label(value):
            return "N/A"
        return value

    def _split_names(self, text: str) -> List[str]:
        if not text or text.lower() in ["n/a", "none", "", "missing", "not available"]:
            return []
        if re.search(r"(?:^|\s|,)\d+\.", text):
            parts = re.split(r"(?:^|\s|,)\d+\.\s*", text)
        else:
            parts = [text]
        final_parts = []
        for p in parts:
            if not p.strip():
                continue
            sub_parts = re.split(r",|\band\b", p)
            for sp in sub_parts:
                name = sp.strip()
                if not name:
                    continue
                name = re.sub(r"\(\d+\)", "", name)
                name = re.sub(r"\.{2,}", ".", name)
                name = name.strip(" -.:")
                if not name:
                    continue
                # Drop leftover label-shaped tokens. Catches the residue
                # of label-collapse cases like "Sellers" / "Buyers" /
                # "Survey No" appearing as a "name" — and the survey
                # tokens that bled into a names list (e.g. "45/4").
                lowered = name.lower().rstrip(":").strip()
                if lowered in self._KNOWN_LABEL_TOKENS:
                    continue
                if re.fullmatch(r"\d+(?:/[\w]+)?", name):
                    # Pure survey-number token like "45/4" or "46/1C".
                    continue
                final_parts.append(name)
        return final_parts

    def extract_raw(self, pdf_path: str):
        """
        Extracts raw EC transactions with Gemini VISION (the pages are sent as a
        PDF/image, not as extracted text).

        ECs are almost always scanned images with no usable text layer —
        page.get_text() returns font garbage, and feeding that garbage to a
        text-only model made it HALLUCINATE fake transactions. Sending the page
        images lets Gemini OCR the real content. Pages are sent in chunks so
        large ECs don't overflow a single request.

        Chunks are OCR'd CONCURRENTLY (Gemini vision is the dominant cost and is
        I/O-bound, so a 50+ page EC that took minutes serially now finishes in a
        couple of waves). PyMuPDF (fitz) is not thread-safe, so all page slicing
        happens up front on the main thread; only the Gemini calls run in the
        pool. Output is identical to the serial version — same OCR_VERSION, so
        existing ec_raw_full.txt caches stay valid (no forced re-OCR).

        Yields progress messages. Returns the full raw text.
        """
        import tempfile
        from concurrent.futures import ThreadPoolExecutor, as_completed

        doc = fitz.open(pdf_path)
        total_pages = doc.page_count
        total_chunks = (total_pages + self.chunk_size - 1) // self.chunk_size

        print(f"[*] Starting EC extraction (vision) for: {pdf_path}")

        # 1. Pre-build every chunk's sub-PDF sequentially (fast, ~50-100ms each).
        #    Keep ALL PyMuPDF work on this thread — fitz Documents aren't
        #    thread-safe.
        tmp_paths: Dict[int, str] = {}
        try:
            for ci in range(total_chunks):
                start = ci * self.chunk_size
                end = min(start + self.chunk_size, total_pages)
                sub = fitz.open()
                sub.insert_pdf(doc, from_page=start, to_page=end - 1)
                tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
                tmp_path = tmp.name
                tmp.close()
                sub.save(tmp_path)
                sub.close()
                tmp_paths[ci] = tmp_path
        finally:
            doc.close()

        # 2. OCR the chunks in parallel. GeminiHelper is thread-safe (shared
        #    client + upload caches are lock-guarded). Bound concurrency so very
        #    large ECs don't trip Gemini rate limits; tune via EC_MAX_CONCURRENCY.
        try:
            max_workers = max(1, min(total_chunks, int(os.getenv("EC_MAX_CONCURRENCY", "6"))))
        except ValueError:
            max_workers = 6
        results: Dict[int, str] = {}
        errors: Dict[int, Exception] = {}
        yield f"Processing {total_chunks} EC chunk(s) with {max_workers} parallel workers..."

        def _ocr_chunk(ci: int) -> str:
            return self.gemini.generate_from_file(
                tmp_paths[ci], RAW_PROMPT, display_name=f"EC chunk {ci + 1}"
            )

        try:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_ci = {executor.submit(_ocr_chunk, ci): ci for ci in range(total_chunks)}
                done = 0
                for future in as_completed(future_to_ci):
                    ci = future_to_ci[future]
                    done += 1
                    try:
                        results[ci] = future.result()
                        yield f"Processed EC Chunk {done} / {total_chunks}..."
                    except Exception as e:
                        errors[ci] = e
                        print(f"    [!] EC chunk {ci + 1} failed: {e}")
        finally:
            # Always clean up the temp sub-PDFs.
            for p in tmp_paths.values():
                try:
                    os.remove(p)
                except OSError:
                    pass

        # Preserve prior behavior: a chunk that failed all retries aborts the
        # run rather than silently dropping pages (which would corrupt the
        # transaction list and the "last N transactions" slice downstream).
        if errors:
            raise errors[sorted(errors)[0]]

        # 3. Reassemble in PAGE ORDER — chunks finish out of order under
        #    parallelism, but parse_to_json depends on document order. Prefix
        #    each chunk with its 1-indexed EC page range so parse_to_json can
        #    stamp every transaction with the page(s) it came from.
        def _chunk_pages(ci: int) -> tuple:
            start = ci * self.chunk_size
            end = min(start + self.chunk_size, total_pages)
            return start + 1, end

        raw_text = "\n".join(
            f"### EC_PAGE start={_chunk_pages(ci)[0]} end={_chunk_pages(ci)[1]} ###\n{results[ci]}"
            for ci in range(total_chunks)
        )
        raw_cache = os.path.join(self.output_dir, "ec_raw_full.txt")
        # Tag the cache with the prompt version so a later run with an
        # updated RAW_PROMPT knows this OCR output is stale.
        with open(raw_cache, "w", encoding="utf-8") as f:
            f.write(f"# OCR_VERSION={self._OCR_VERSION}\n")
            f.write(raw_text)
        return raw_text

    @staticmethod
    def _backfill_doc_year(doc_no: str, date_str: str) -> str:
        """
        When Gemini emits a bare serial as the document number (e.g. "266"
        instead of "266/2009") rewrite it using the year from the entry's
        date. Without this, the deed-matcher can't link the row to the
        PDF in the upload (filenames are uniformly "<serial>_<year>.pdf"),
        and "last N transactions" returns the wrong slice.

        Only modifies values that look like a bare serial — anything with
        an existing year ("266/2009"), an existing separator, or non-digit
        characters is left alone.
        """
        if not doc_no or doc_no in ("N/A", ""):
            return doc_no
        stripped = doc_no.strip()
        # Already has year-suffix in some form → leave untouched.
        if re.search(r"[\/\-_]\d{4}\b", stripped):
            return stripped
        # Only act on pure-digit serials (with optional surrounding whitespace).
        if not re.fullmatch(r"\d+", stripped):
            return stripped
        # Pull the year from the date — accept many formats via dateutil
        # if available, else fall back to a simple 4-digit extraction.
        year = None
        try:
            from dateutil.parser import parse as _dateutil_parse  # type: ignore
            try:
                year = _dateutil_parse(date_str or "", dayfirst=True, fuzzy=True).year
            except Exception:
                year = None
        except Exception:
            pass
        if year is None:
            m = re.search(r"(19|20)\d{2}", date_str or "")
            if m:
                year = int(m.group(0))
        if year is None:
            return stripped  # genuinely no year context — leave bare
        return f"{stripped}/{year}"

    def parse_to_json(self, raw_text: str) -> List[Dict[str, Any]]:
        """
        Parses raw text blocks into structured JSON.
        """
        # Walk the raw text in order, tracking the most recent EC_PAGE marker
        # (emitted per chunk by extract_raw) so each transaction is stamped with
        # the EC page range it came from. Tolerates older caches with no markers
        # (page stays None and the EC debugger falls back to a full scan).
        token_re = re.compile(
            r"###\s*EC_PAGE\s+start=(\d+)\s+end=(\d+)\s*###"
            r"|--- TRANSACTION START ---.*?--- TRANSACTION END ---",
            flags=re.S,
        )
        transactions: List[Dict[str, Any]] = []
        cur_page_start: Any = None
        cur_page_end: Any = None
        for _tok in token_re.finditer(raw_text):
            if _tok.group(1):  # page marker
                cur_page_start = int(_tok.group(1))
                cur_page_end = int(_tok.group(2))
                continue
            block = _tok.group(0)
            raw_doc_no = self._extract_field(block, "Document No")
            raw_date = self._extract_field(block, "Date")
            # Resolve the SINGLE EC page this transaction sits on. Gemini emits
            # `Page: N` = the 1-based page WITHIN the chunk; convert to an
            # absolute EC page (chunk_start + N - 1). When the value is missing
            # or out of range we keep the whole chunk range as a fallback so the
            # EC visual debugger still finds it (its fallback sweep handles the
            # off-by-one cases). A single page is what lets the debugger scan
            # one page instead of the entire chunk span.
            page_start, page_end = cur_page_start, cur_page_end
            raw_page = self._extract_field(block, "Page")
            if isinstance(cur_page_start, int) and isinstance(cur_page_end, int):
                m_pg = re.search(r"\d+", str(raw_page or ""))
                if m_pg:
                    abs_pg = cur_page_start + int(m_pg.group(0)) - 1
                    if cur_page_start <= abs_pg <= cur_page_end:
                        page_start = page_end = abs_pg
            # Defensive: if Gemini dropped the year suffix on the doc_no
            # (a recurring TN-EC extraction quirk for tail rows), reconstruct
            # it from the transaction's date so downstream matching works.
            fixed_doc_no = self._backfill_doc_year(raw_doc_no, raw_date)
            # Base transaction structure for this EC entry
            base_tx: Dict[str, Any] = {
                "document_number": fixed_doc_no,
                "date": raw_date,
                "nature_of_document": self._extract_field(
                    block, "Nature of Document"
                ),
                "property_type": self._extract_field(block, "Nature of the land"),
                "sellers": self._split_names(self._extract_field(block, "Sellers")),
                "buyers": self._split_names(self._extract_field(block, "Buyers")),
                "property_extent": self._extract_field(block, "Extent"),
                "consideration": self._extract_field(block, "Consideration"),
                "market_value": self._extract_field(block, "Market Value"),
                "ec_page_start": page_start,
                "ec_page_end": page_end,
            }

            # Survey number can contain multiple entries for the same document like "13, 13/2, 13/3A".
            survey_raw = self._extract_field(block, "Survey No")
            # Split by common delimiters, but keep full tokens including subdivision (e.g., "13/2").
            survey_parts = [
                s.strip()
                for s in re.split(r"[;,]", survey_raw)
                if s.strip()
            ] or [survey_raw]

            def normalize_sn(s: str) -> str:
                # Remove common noise like " - 3 ACRE", "(Part)", whitespace, etc.
                s = re.sub(r"\s*-\s*.*$", "", s) # Remove everything after hyphen
                s = re.sub(r"\(.*?\)", "", s)    # Remove parenthetical notes
                # Keep only alphanumeric and slash
                s = re.sub(r"[^a-zA-Z0-9/]", "", s)
                return s.strip()

            for sn_raw in survey_parts:
                sn = sn_raw.strip()
                normalized_sn = normalize_sn(sn)
                
                tx = base_tx.copy()
                tx["survey_number"] = normalized_sn
                tx["survey_raw"] = sn
                tx["involved_surveys"] = [normalize_sn(s) for s in survey_parts]

                # Optionally capture base survey and subdivision for downstream use
                if "/" in normalized_sn:
                    base, sub = normalized_sn.split("/", 1)
                    tx["survey_base"] = base.strip()
                    tx["sub_division"] = sub.strip()
                else:
                    tx["survey_base"] = normalized_sn.strip()
                    tx["sub_division"] = None

                transactions.append(tx)

        return transactions


    def analyze_historical_values(self, pdf_path: str):
        """
        Specialized extraction to calculate historical property values from EC.
        Yields progress messages.
        Returns the processed JSON data.
        """
        pages = []
        with fitz.open(pdf_path) as doc:
            for page in doc:
                pages.append(page.get_text() or "")
        
        all_analysis = []
        total_chunks = (len(pages) + self.chunk_size - 1) // self.chunk_size

        print(f"[*] Starting Historical Value Analysis for: {pdf_path}")

        for i in range(0, len(pages), self.chunk_size):
            chunk_num = i // self.chunk_size + 1
            msg = f"Analyzing EC Chunk {chunk_num} / {total_chunks}..."
            print(f"    -> {msg}")
            yield msg

            chunk_text = "\n".join(pages[i : i + self.chunk_size])
            # Use the specialized prompt
            prompt = EC_ANALYSIS_PROMPT.format(input_text=chunk_text)
            response = self.gemini.generate_from_text(chunk_text, prompt)
            
            try:
                # Clean the response in case Gemini adds markdown backticks
                json_str = response.strip()
                if json_str.startswith("```"):
                    json_str = re.sub(r"^```json\s*|\s*```$", "", json_str, flags=re.MULTILINE)
                
                chunk_data = json.loads(json_str)
                if isinstance(chunk_data, list):
                    all_analysis.extend(chunk_data)
            except Exception as e:
                print(f"[!] Error parsing chunk {chunk_num}: {e}")
                # Log the error but continue with other chunks
                continue

        # Save to output directory
        analysis_output_path = os.path.join(self.output_dir, "ec_historical_values.json")
        with open(analysis_output_path, "w", encoding="utf-8") as f:
            json.dump(all_analysis, f, ensure_ascii=False, indent=2)

        print(f"[+] Historical Value Analysis complete. Saved to {analysis_output_path}")
        return all_analysis

    def process(self, pdf_path: str, cache_path: str = None):
        """
        Full EC extraction process. Yields progress messages.
        Returns the final JSON data — a list of transaction dicts (the same
        contract the matcher and DB-persistence code have always expected).

        Cache layout written to disk (designed so downstream readers that
        open ec_final.json directly keep working):
          ec_final.json      = [ ...transactions ]              # legacy shape
          ec_final.meta.json = { "parse_version": <int> }       # sidecar
          ec_raw_full.txt    = "# OCR_VERSION=N\\n" + raw text  # OCR cache

        Version checks live in the sidecar / header — bumping _PARSE_VERSION
        or _OCR_VERSION invalidates the matching cache without changing the
        on-disk format of ec_final.json (which other modules read directly).
        """
        output_path = os.path.join(self.output_dir, "ec_final.json")
        meta_path = os.path.join(self.output_dir, "ec_final.meta.json")
        raw_cache_default = os.path.join(self.output_dir, "ec_raw_full.txt")
        if cache_path is None and os.path.exists(raw_cache_default):
            cache_path = raw_cache_default

        # Reuse ec_final.json only if the sidecar confirms a matching parse version.
        if os.path.exists(output_path):
            sidecar_v = None
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        sidecar_v = (json.load(f) or {}).get("parse_version")
                except (json.JSONDecodeError, OSError):
                    sidecar_v = None
            if sidecar_v == self._PARSE_VERSION:
                try:
                    with open(output_path, "r", encoding="utf-8") as f:
                        cached = json.load(f)
                    if isinstance(cached, list):
                        print(
                            f"[*] Found valid EC cache (parse v{self._PARSE_VERSION}): "
                            f"{output_path}. Skipping Gemini extraction."
                        )
                        return cached
                except (json.JSONDecodeError, OSError):
                    print("[!] Existing EC data is corrupt. Re-processing...")
            else:
                print(
                    f"[*] EC cache parser-version mismatch (sidecar v{sidecar_v} -> "
                    f"current v{self._PARSE_VERSION}). Re-parsing from raw OCR cache."
                )

        if cache_path and os.path.exists(cache_path):
            with open(cache_path, "r", encoding="utf-8") as f:
                cached_raw = f.read()
            m = self._OCR_HEADER_RE.match(cached_raw)
            cached_ocr_v = int(m.group(1)) if m else None
            if cached_ocr_v == self._OCR_VERSION:
                print(
                    f"[*] Using cached EC raw data (OCR v{self._OCR_VERSION}): {cache_path}"
                )
                raw_text = cached_raw[m.end():]
            else:
                print(
                    f"[*] EC raw cache prompt-version mismatch "
                    f"(cache v{cached_ocr_v} -> current v{self._OCR_VERSION}). "
                    f"Re-running Gemini OCR with the updated prompt."
                )
                raw_text = yield from self.extract_raw(pdf_path)
        else:
            raw_text = yield from self.extract_raw(pdf_path)

        data = self.parse_to_json(raw_text)

        # Write the LIST verbatim (legacy on-disk contract) + a tiny sidecar.
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        try:
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump({"parse_version": self._PARSE_VERSION}, f)
        except OSError as e:
            print(f"[!] Could not write sidecar {meta_path}: {e}")

        print(f"[+] EC Processing complete. Saved to {output_path}")
        return data
