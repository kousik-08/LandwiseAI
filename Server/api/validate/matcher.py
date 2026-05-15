import os
import re
import shutil
import uuid
from pathlib import Path
from typing import List, Dict, Optional
import json
from datetime import datetime


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
        print(f"[*] Workspace created: {self.workspace}")

    def _normalize_doc_no(self, doc_no: str) -> str:
        """Deep normalization for robust document number matching."""
        if not doc_no or doc_no == "N/A": return ""
        # Remove all whitespace, lowercase, and convert separators to underscore
        norm = str(doc_no).strip().lower()
        norm = re.sub(r'[\s\-/]', '_', norm) # Replace space, hyphen, slash with underscore
        norm = re.sub(r'_+', '_', norm)      # Collapse multiple underscores
        return norm

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

        # 1. Sort data by date (newest to oldest)
        def parse_date(entry):
            date_str = entry.get("date", "")
            try:
                # Format used in EC: 24-Jul-1985
                return datetime.strptime(date_str, "%d-%b-%Y")
            except (ValueError, TypeError):
                return datetime.min
        
        ec_data.sort(key=parse_date, reverse=True) # Newest first

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
            
            # Check for file
            matched_file = file_map.get(norm_doc)
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
                print(f"[OK] Matched [{len(matches)}]: {doc_no}")
                
                # Check if we hit our limit
                if effective_limit > 0 and len(matches) >= effective_limit:
                    break
            else:
                # User requested skipping missing files to find previous ones
                pass

        # 5. Reverse matches so they are chronological (oldest to newest) for the rest of the workflow
        matches.reverse()
        
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
