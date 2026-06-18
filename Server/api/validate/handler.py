import os
import json
import time
import zipfile
import shutil
import uuid
import re
import hashlib
from datetime import datetime
from typing import Optional
from fastapi import HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

# Relative imports assuming this file is in api/validate/
from api.validate.ec_processor import ECProcessor
from api.validate.matcher import DocumentMatcher
from api.validate.sale_deed_processor import SaleDeedProcessor
from api.validate.validator import Validator
from api.validate.hierarchy_generator import HierarchyGenerator
from api.validate.supporting_verifier import SupportingVerifier
from common.database import SessionLocal
from common.models import ValidationRequest, ECRecord, ValidationResult
from common.storage_sync import sync_dir, sync_file, ensure_local, read_json, write_json
from common.workflow_checkpoint import WorkflowCheckpoint
from common.run_paths import RunPaths
from common.storage import get_storage
from common.landwise_models import (
    LandwiseDocument, Parcel, Owner, OwnershipTransfer, Encumbrance,
    RiskFlag, ConsistencyCheck, ConsistencyMismatch, ChecklistItem,
    LegalOpinion, AnalysisResult, ExtractedField
)
from common.perf_cache import TTLCache

# Hierarchy responses are immutable per request_id (a new analysis run
# generates a fresh request_id), so a 10-minute TTL is generous and safe.
# Caching here saves ~4 sequential S3 reads + JSON parsing + react-flow
# generation per parcel-page load.
_HIERARCHY_CACHE = TTLCache(maxsize=64, ttl=600.0)


# Canonical cache index lives in storage (S3), not local disk, so the
# pipeline survives a tmp/ wipe and works across multiple servers.
CACHE_INDEX_KEY = "outputs/validate_cache_index.json"
# v2: include visual_debug in cache key so cached runs
# don't incorrectly skip visual debug artifact generation.
CACHE_PIPELINE_VERSION = "v2"


def _load_cache_index() -> dict:
    return read_json(CACHE_INDEX_KEY, default={}) or {}


def _save_cache_index(index: dict) -> None:
    write_json(CACHE_INDEX_KEY, index)


def _compute_file_hash_from_path(path: str) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _compute_dir_pdf_hash(dir_path: str) -> str:
    """Compute a stable hash over all PDFs in a directory tree."""
    hasher = hashlib.sha256()
    pdf_paths = []
    for root, _, files in os.walk(dir_path):
        for name in files:
            if name.lower().endswith(".pdf"):
                pdf_paths.append(os.path.join(root, name))
    pdf_paths.sort()
    for path in pdf_paths:
        rel = os.path.relpath(path, dir_path).replace("\\", "/")
        hasher.update(rel.encode("utf-8"))
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                hasher.update(chunk)
    return hasher.hexdigest()


def _make_cache_key_for_local_paths(
    ec_pdf_path: str,
    registration_docs_dir: str,
    transaction_limit: Optional[int],
    visual_debug: bool,
) -> str:
    ec_hash = _compute_file_hash_from_path(ec_pdf_path)
    docs_hash = _compute_dir_pdf_hash(registration_docs_dir)
    limit_part = "all" if transaction_limit in (None, 0) else str(transaction_limit)
    vd_part = "1" if visual_debug else "0"
    return f"local:{ec_hash}:{docs_hash}:tx={limit_part}:vd={vd_part}"


def _make_cache_key_for_files_hashes(
    ec_hash: str,
    zip_hash: str,
    transaction_limit: Optional[int],
    visual_debug: bool,
) -> str:
    limit_part = "all" if transaction_limit in (None, 0) else str(transaction_limit)
    vd_part = "1" if visual_debug else "0"
    return f"files:{ec_hash}:{zip_hash}:tx={limit_part}:vd={vd_part}"


class WorkflowRequest(BaseModel):
    type: str = Field(..., description="Input type: 'local_path' or 'files'")
    ec_pdf_path: Optional[str] = Field(
        None, description="Path to EC PDF (for local_path type)"
    )
    registration_docs_dir: Optional[str] = Field(
        None, description="Path to registration docs directory (for local_path type)"
    )
    stream: bool = False
    visual_debug: bool = False
    transaction_limit: Optional[int] = Field(None, description="Limit to last N transactions")


def workflow_generator(
    *,
    ec_pdf_path: str,
    registration_docs_dir: str,
    processing_id: str,
    processing_output_dir: str,
    visual_debug: bool = False,
    survey_number: Optional[str] = None,
    transaction_limit: Optional[int] = None,
    logger=None,
):
    """
    Generator that executes the full document processing workflow and yields progress updates.
    Yields JSON objects with:
    - type: "step_start", "step_complete", "log", "sub_log", "error", "result"
    - step: (optional) step identifier
    - status: (optional) "success", "failed"
    - message: (optional)
    """

    # Helper to yield structured events
    def event(type_, **kwargs):
        return {"type": type_, **kwargs}

    # Define a helper to wrap sub-generators for granular logging
    def sub_log_wrapper(gen, step):
        it = iter(gen)
        while True:
            try:
                msg = next(it)
                # 1. Send to frontend as sub_log
                yield event("sub_log", message=msg, step=step)
                # 2. Log to file
                if logger:
                    logger._write_log(
                        {
                            "type": "sub_log",
                            "time": logger._get_timestamp(),
                            "message": msg,
                            "status": "info",
                        }
                    )
            except StopIteration as e:
                return e.value

    yield event("log", message=f"=== [STARTING WORKFLOW: {processing_id}] ===")
    
    # 0. Initialize DB Entry
    db = SessionLocal()
    try:
        req = ValidationRequest(
            id=processing_id,
            type="local_path" if ec_pdf_path.startswith("inputs") else "files", # approximate
            ec_pdf_path=ec_pdf_path,
            status="processing"
        )
        db.merge(req) # Use merge to handle potential re-runs
        db.commit()
    except Exception as e:
        print(f"Failed to init DB entry: {e}")
    finally:
        db.close()

    # Configuration
    chunk_size = int(os.getenv("CHUNK_SIZE", 8))
    ec_json_path = os.path.join(processing_output_dir, "ec_final.json")
    matched_docs = []
    results = []
    matcher = None  # Initialize matcher to None for cleanup in finally block

    # Canonical S3 prefix for everything written under processing_output_dir.
    _s3_output_prefix = f"outputs/validate/{processing_id}"

    # Workflow checkpoint persisted to S3 (and local mirror) on every stage transition
    checkpoint = WorkflowCheckpoint(request_id=processing_id, kind="validate")
    checkpoint._persist()

    try:
        # 1. EC Processing
        yield event("step_start", step="ec_extraction", label="EC Extraction")
        checkpoint.start_stage("ec_extraction")
        try:
            if logger:
                logger._write_log(
                    {
                        "type": "stage",
                        "time": logger._get_timestamp(),
                        "message": "Starting EC Extraction",
                        "status": "started",
                        "data": {
                            "stage": "ec_extraction",
                            "output_dir": processing_output_dir,
                        },
                    }
                )
            yield event(
                "log", message="Starting EC Extraction...", step="ec_extraction"
            )
            ec_proc = ECProcessor(
                output_dir=processing_output_dir, chunk_size=chunk_size
            )
            yield from sub_log_wrapper(
                ec_proc.process(ec_pdf_path), "ec_extraction"
            )
            
            # Persist EC Records to DB
            if os.path.exists(ec_json_path):
                db = SessionLocal()
                try:
                    with open(ec_json_path, "r", encoding="utf-8") as f:
                        ec_data = json.load(f)
                    # Defensive: tolerate the dict-envelope shape an
                    # intermediate build briefly used. New writes are
                    # always plain lists.
                    if isinstance(ec_data, dict) and isinstance(ec_data.get("data"), list):
                        ec_data = ec_data["data"]
                    if not isinstance(ec_data, list):
                        ec_data = []
                    for entry in ec_data:
                        ec_rec = ECRecord(
                            request_id=processing_id,
                            document_number=entry.get("document_number"),
                            date=entry.get("date"),
                            nature=entry.get("nature"),
                            executant=entry.get("executant"),
                            claimant=entry.get("claimant"),
                            survey_number=entry.get("survey_number"),
                            area=entry.get("area"),
                            json_data=entry
                        )
                        db.add(ec_rec)
                    db.commit()
                except Exception as e:
                    print(f"Failed to persist EC records: {e}")
                finally:
                    db.close()

            try:
                sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            except Exception as _e:
                print(f"Stage sync (ec) failed: {_e}")
            checkpoint.complete_stage("ec_extraction", "success")
            yield event("step_complete", step="ec_extraction", status="success")
        except Exception as e:
            yield event(
                "log", message=f"EC Extraction Failed: {e}", step="ec_extraction"
            )
            yield event(
                "step_complete", step="ec_extraction", status="failed", error=str(e)
            )
            checkpoint.fail_stage("ec_extraction", str(e))
            raise e  # Stop workflow on critical failure

        # 2. Document Matching
        yield event("step_start", step="matching", label="Document Matching")
        checkpoint.start_stage("matching")
        try:
            if logger:
                logger._write_log(
                    {
                        "type": "stage",
                        "time": logger._get_timestamp(),
                        "message": "Starting Document Matching",
                        "status": "started",
                        "data": {"stage": "matching"},
                    }
                )
            yield event("log", message="Matching documents...", step="matching")
            matched_docs_dir = os.path.join(processing_output_dir, "matched_docs")
            matcher = DocumentMatcher(
                docs_dir=registration_docs_dir,
                output_base=matched_docs_dir,
                keep_workspace=True,
            )
            
            # Determine the effective limit for matching
            # If transaction_limit is None or negative, treat as 'all' (0 = unlimited)
            if transaction_limit is None or transaction_limit < 0:
                match_limit = 0  # 0 means process ALL documents, no limit
            else:
                match_limit = transaction_limit
                
            matched_docs = matcher.load_and_match(ec_json_path, limit=match_limit)

            # Check for missing documents to alert user why count is lower
            found_nos = {matcher._normalize_doc_no(d["document_number"]) for d in matched_docs}
            # We need to re-read targets or pass them back from load_and_match
            # For now, let's just log based on len mismatch
            match_count = len(matched_docs)

            yield event(
                "sub_log", message=f"{match_count} documents matched from ZIP", step="matching"
            )

            if match_limit and match_count < match_limit:
                 yield event("log", message=f"(i) Note: Only {match_count} unique documents were found for matching (requested {match_limit}). This happens due to deduplication or missing files.", step="matching")

            # When the user picked "last N" but we had to dig past skipped
            # docs (their PDFs weren't in the upload zip), tell them WHICH
            # newer transactions got passed over. Without this, the user
            # sees an old slice (e.g. 1990–2011) when their EC actually
            # extends to recent years, and has no idea WHY. The matcher
            # walks newest-first, so skipped_no_pdf is always newer than
            # the oldest match in `matched_docs`.
            skipped = getattr(matcher, "last_skipped_no_pdf", []) or []
            if match_limit and skipped:
                total_ec = getattr(matcher, "last_total_ec_entries", 0)
                yield event(
                    "log",
                    message=(
                        f"⚠ Heads up: you asked for the last {match_limit} transactions, "
                        f"but {len(skipped)} newer EC transaction(s) had no matching PDF in "
                        f"your upload zip — so we dug deeper into the EC history to fill the "
                        f"quota. The selection you're seeing reaches back further in time "
                        f"than the actual newest {match_limit} transactions in the EC "
                        f"({total_ec} transactions total)."
                    ),
                    step="matching",
                )
                preview = skipped[: min(len(skipped), max(match_limit, 10))]
                skipped_str = ", ".join(
                    f"{s['document_number']} ({s.get('date') or 'N/A'})" for s in preview
                )
                more = "" if len(skipped) <= len(preview) else f", … (+{len(skipped) - len(preview)} more)"
                yield event(
                    "sub_log",
                    message=(
                        f"Skipped newer transactions (PDF missing in upload): "
                        f"{skipped_str}{more}"
                    ),
                    step="matching",
                )
                yield event(
                    "sub_log",
                    message=(
                        "To see those newer transactions instead, add their deed PDFs to the "
                        "zip — filenames should match the doc number (e.g. '4939_2018.pdf' or '4939/2018.pdf')."
                    ),
                    step="matching",
                )

            # List the matched documents
            doc_list_str = ", ".join(
                [d.get("document_number", "N/A") for d in matched_docs]
            )
            yield event(
                "log", message=f"Matched Documents: {doc_list_str}", step="matching"
            )

            # Persist matched PDFs to the global vault. Local scratch lives
            # under tmp/work/_vault — S3 key is outputs/storage/vault/<name>.
            vault_local = os.path.join("tmp", "work", "_vault")
            os.makedirs(vault_local, exist_ok=True)
            for doc in matched_docs:
                src_path = doc.get("file_path")
                doc_no = doc.get("document_number")
                if src_path and doc_no and os.path.exists(src_path):
                    safe_name = re.sub(r'[^a-zA-Z0-9]', '_', str(doc_no)) + ".pdf"
                    dst_path = os.path.join(vault_local, safe_name)
                    vault_key = f"outputs/storage/vault/{safe_name}"
                    try:
                        shutil.copy2(src_path, dst_path)
                        doc["vault_path"] = f"storage/vault/{safe_name}"  # frontend path (served via /files)
                        sync_file(dst_path, content_type="application/pdf", key=vault_key)
                    except Exception as e:
                        print(f"Failed to copy to vault: {e}")

            try:
                sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            except Exception as _e:
                print(f"Stage sync (matching) failed: {_e}")
            checkpoint.complete_stage("matching", "success")
            yield event("step_complete", step="matching", status="success")
        except Exception as e:
            yield event("log", message=f"Matching Failed: {e}", step="matching")
            yield event("step_complete", step="matching", status="failed", error=str(e))
            checkpoint.fail_stage("matching", str(e))
            raise e

        # 3. Sale Deed Extraction
        yield event(
            "step_start", step="sale_deed_extraction", label="Sale Deed Extraction"
        )
        checkpoint.start_stage("sale_deed_extraction")
        try:
            if logger:
                logger._write_log(
                    {
                        "type": "stage",
                        "time": logger._get_timestamp(),
                        "message": "Starting Sale Deed Extraction",
                        "status": "started",
                        "data": {"stage": "sale_deed_extraction"},
                    }
                )
            yield event(
                "log",
                message="Processing each document (extract + validate) and streaming results...",
                step="sale_deed_extraction",
            )
            # Per-document pipeline: extract the deed metadata AND validate it
            # against the EC for EACH document, streaming the result the moment
            # it finishes — so the FIRST document's output appears immediately
            # instead of waiting for every document to be extracted first.
            # validate_single_doc extracts the metadata on demand, so by the
            # time hierarchy runs (below) all metadata is present.
            validator = Validator(output_dir=processing_output_dir, ec_pdf_path=ec_pdf_path)
            try:
                with open(ec_json_path, "r", encoding="utf-8") as _ecf:
                    _ec_lookup = {e.get("document_number"): e for e in json.load(_ecf)}
            except Exception:
                _ec_lookup = {}

            # process_matched_list(matched_docs) replaced with granular loop
            total_docs = len(matched_docs)
            
            if total_docs >= 2:
                from concurrent.futures import ThreadPoolExecutor
                yield event("log", message=f"Processing {total_docs} documents (extract + validate) with 3 workers...", step="sale_deed_extraction")
                
                with ThreadPoolExecutor(max_workers=3) as executor:
                    futures = {executor.submit(validator.validate_single_doc, doc, ec_json_path, visual_debug, _ec_lookup): doc for doc in matched_docs}
                    done_count = 0
                    for future in futures:
                        doc = futures[future]
                        doc_num = doc.get("document_number", "Unknown")
                        try:
                            _res = future.result()
                        except Exception as _fe:
                            yield event("log", message=f"Processing crashed for {doc_num}: {_fe}", step="sale_deed_extraction")
                            continue
                        done_count += 1
                        if _res:
                            results.append(_res)
                            _st = "[MATCHED]" if _res.get("match") else "[ISSUE]"
                            yield event("log", message=f"[{done_count}/{total_docs}] {doc_num}: {_st}", step="sale_deed_extraction")
                            yield event("partial_result", data=_res)
            else:
                for idx, doc in enumerate(matched_docs, 1):
                    doc_num = doc.get("document_number", "Unknown")
                    _res = validator.validate_single_doc(doc, ec_json_path, visual_debug=visual_debug, ec_lookup=_ec_lookup)
                    if _res:
                        results.append(_res)
                        _st = "[MATCHED]" if _res.get("match") else "[ISSUE]"
                        yield event("log", message=f"[{idx}/{total_docs}] {doc_num}: {_st}", step="sale_deed_extraction")
                        yield event("partial_result", data=_res)

            try:
                sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            except Exception as _e:
                print(f"Stage sync (sale_deed) failed: {_e}")
            checkpoint.complete_stage("sale_deed_extraction", "success")
            yield event("step_complete", step="sale_deed_extraction", status="success")
        except Exception as e:
            yield event(
                "log",
                message=f"Sale Deed Extraction Failed: {e}",
                step="sale_deed_extraction",
            )
            yield event(
                "step_complete",
                step="sale_deed_extraction",
                status="failed",
                error=str(e),
            )
            checkpoint.fail_stage("sale_deed_extraction", str(e))
            raise e

        # 3.5. Hierarchy Generation (Enriched with metadata)
        yield event("step_start", step="hierarchy", label="Hierarchy Generation")
        checkpoint.start_stage("hierarchy")
        try:
            if logger:
                logger._write_log(
                    {
                        "type": "stage",
                        "time": logger._get_timestamp(),
                        "message": "Starting Hierarchy Generation",
                        "status": "started",
                        "data": {"stage": "hierarchy"},
                    }
                )
            yield event("log", message="Generating enriched hierarchy tree...", step="hierarchy")
            hierarchy_gen = HierarchyGenerator(output_dir=processing_output_dir)
            yield from sub_log_wrapper(
                hierarchy_gen.process(ec_pdf_path, matched_docs=matched_docs, source_docs_dir=registration_docs_dir, limit=transaction_limit), "hierarchy"
            )
            try:
                sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            except Exception as _e:
                print(f"Stage sync (hierarchy) failed: {_e}")
            checkpoint.complete_stage("hierarchy", "success")
            yield event("step_complete", step="hierarchy", status="success")
        except Exception as e:
            yield event("log", message=f"Hierarchy Generation Failed: {e}", step="hierarchy")
            yield event("step_complete", step="hierarchy", status="failed", error=str(e))
            checkpoint.fail_stage("hierarchy", str(e))
            # Hierarchy is optional

        # 4. Validation
        yield event("step_start", step="validation", label="Validation")
        checkpoint.start_stage("validation")
        try:
            if logger:
                logger._write_log(
                    {
                        "type": "stage",
                        "time": logger._get_timestamp(),
                        "message": "Starting Validation",
                        "status": "started",
                        "data": {"stage": "validation"},
                    }
                )
            yield event("log", message="Validating against EC...", step="validation")
            validator = Validator(output_dir=processing_output_dir, ec_pdf_path=ec_pdf_path)
            
            total_docs = len(matched_docs)
            # 'results' is already populated by the per-document stage above, so
            # the loop below is skipped (guarded by `not results`); it remains as
            # a fallback if validation is ever reached without pre-processing.

            # Prepare EC lookup once for both paths
            if not os.path.exists(ec_json_path):
                ec_lookup = {}
            else:
                with open(ec_json_path, "r", encoding="utf-8") as f:
                    ec_data = json.load(f)
                ec_lookup = {entry.get("document_number"): entry for entry in ec_data}

            if not results and total_docs >= 2:
                yield event("log", message=f"Running parallel validation for {total_docs} documents...", step="validation")
                from concurrent.futures import ThreadPoolExecutor, as_completed

                with ThreadPoolExecutor(max_workers=3) as executor:
                    future_to_doc = {executor.submit(validator.validate_single_doc, doc, ec_json_path, visual_debug, ec_lookup): doc for doc in matched_docs}

                    # as_completed yields futures in COMPLETION order, not
                    # submission order. The previous `for future in
                    # future_to_doc` iterated insertion order and called
                    # .result() on each — which BLOCKS until that specific
                    # future finishes. Net effect: if doc #1's visual
                    # debugger hangs for 10 minutes, every later doc that
                    # finished in 2s gets held back from being yielded, and
                    # the frontend looks empty until the slow doc finally
                    # unblocks. as_completed lets fast docs surface
                    # immediately and the slow one stops blocking the rest.
                    completed = 0
                    for future in as_completed(future_to_doc):
                        try:
                            res = future.result()
                        except Exception as e:
                            doc = future_to_doc[future]
                            doc_no = doc.get("document_number", "?") if isinstance(doc, dict) else "?"
                            yield event("log", message=f"Validation crashed for {doc_no}: {e}", step="validation")
                            continue
                        if res:
                            results.append(res)
                            completed += 1
                            status = "[MATCHED]" if res.get("match") else "[ISSUE]"
                            yield event("log", message=f"[{completed}/{total_docs}] Validated {res['document_number']}: {status}", step="validation")
                            # Yield incremental result
                            yield event("partial_result", data=res)
            elif not results:
                for idx, doc in enumerate(matched_docs, 1):
                    res = validator.validate_single_doc(doc, ec_json_path, visual_debug=visual_debug, ec_lookup=ec_lookup)
                    if res:
                        results.append(res)
                        status = "[MATCHED]" if res.get("match") else "[ISSUE]"
                        yield event("log", message=f"[{idx}/{total_docs}] Validated {res['document_number']}: {status}", step="validation")
                        # Yield incremental result
                        yield event("partial_result", data=res)

            # Sub-log for validation summary
            pass_count = sum(1 for r in results if r.get("match"))
            yield event(
                "sub_log",
                message=f"{pass_count}/{len(results)} validated successfully",
                step="validation",
            )
            # Persist Validation Results to DB
            db = SessionLocal()
            try:
                for res in results:
                    v_res = ValidationResult(
                        request_id=processing_id,
                        document_number=res.get("document_number"),
                        match=res.get("match"),
                        trustability_score=res.get("validation_result", {}).get("trustability_score"),
                        reason_for_failure=res.get("reason_for_failure"),
                        comparisons=res.get("validation_result", {}).get("comparisons"),
                        file_path=res.get("file_path"),
                        vault_path=res.get("vault_path")
                    )
                    db.add(v_res)
                
                # Update status
                req = db.query(ValidationRequest).get(processing_id)
                if req:
                    req.status = "completed"
                db.commit()
            except Exception as e:
                print(f"Failed to persist validation results: {e}")
            finally:
                db.close()

            try:
                sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            except Exception as _e:
                print(f"Stage sync (validation) failed: {_e}")
            checkpoint.complete_stage("validation", "success")
            yield event("step_complete", step="validation", status="success")
        except Exception as e:
            yield event("log", message=f"Validation Failed: {e}", step="validation")
            yield event(
                "step_complete", step="validation", status="failed", error=str(e)
            )
            checkpoint.fail_stage("validation", str(e))
            raise e

        # Final Summary Log
        yield event("log", message="\n=== [WORKFLOW COMPLETE] ===")
        for res in results:
            status = "[MATCHED]" if res.get("match") else "[ISSUE]"
            yield event("log", message=f"{status} | {res['document_number']}")

        final_result = {
            "status": "success",
            "output_dir": processing_output_dir,
            "request_id": processing_id,
            "results": results,
            "hierarchy_path": f"validate/{processing_id}/hierarchy_view.html",
        }
        # Persist final result for potential cache reuse
        try:
            final_path = os.path.join(processing_output_dir, "final_result.json")
            with open(final_path, "w", encoding="utf-8") as f:
                json.dump(final_result, f, ensure_ascii=False, indent=2)
        except Exception as e:
            # Do not fail the workflow if caching persistence has an issue
            print(f"Failed to persist final_result for caching: {e}")
        
        # Also persist flat results.json for risk score engine
        try:
            results_path = os.path.join(processing_output_dir, "results.json")
            with open(results_path, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Failed to persist results.json: {e}")

        # Final pass — mirror everything still on local scratch to S3.
        try:
            n = sync_dir(processing_output_dir, key_prefix=_s3_output_prefix)
            if n:
                yield event("log", message=f"Synced {n} files to storage backend")
        except Exception as e:
            print(f"Storage sync failed (non-fatal): {e}")

        checkpoint.finish("completed")

        # Note: 'result' events are part of the stream.
        # When not streaming, we capture this and wrap it using construct_output
        yield event("result", data=final_result)

    except Exception as e:
        # Top-level catch to ensure any unhandled errors are reported
        yield event("error", message=f"Workflow failed: {e}")
        try:
            checkpoint.finish("failed", error=str(e))
        except Exception:
            pass
        # We don't re-raise here to avoid crashing the stream connection abruptly
    finally:
        # 5. Cleanup
        try:
            if matcher:
                matcher.cleanup()
        except Exception as e:
            yield event("log", message=f"Cleanup failed: {e}")


def run_workflow_sync(
    *,
    ec_pdf_path: str,
    registration_docs_dir: str,
    processing_id: str,
    processing_output_dir: str,
    visual_debug: bool = False,
    survey_number: Optional[str] = None,
    transaction_limit: Optional[int] = None,
    logger=None,
):
    """
    Executes the workflow synchronously and returns standard response.
    """
    gen = workflow_generator(
        ec_pdf_path=ec_pdf_path,
        registration_docs_dir=registration_docs_dir,
        processing_id=processing_id,
        processing_output_dir=processing_output_dir,
        visual_debug=visual_debug,
        survey_number=survey_number,
        transaction_limit=transaction_limit,
        logger=logger,
    )
    final_output = None
    try:
        for item in gen:
            if item["type"] == "log":
                print(item["message"])
            elif item["type"] == "error":
                print(item["message"])
            elif item["type"] == "result":
                final_output = item["data"]
    except Exception as e:
        raise e

    # Wrap final output using common helper
    return final_output


def stream_generator(
    *,
    ec_pdf_path: str,
    registration_docs_dir: str,
    processing_id: str,
    processing_output_dir: str,
    visual_debug: bool = False,
    survey_number: Optional[str] = None,
    transaction_limit: Optional[int] = None,
    logger=None,
):
    """
    Helper to yield formatting JSON strings for SSE/StreamingResponse
    """
    gen = workflow_generator(
        ec_pdf_path=ec_pdf_path,
        registration_docs_dir=registration_docs_dir,
        processing_id=processing_id,
        processing_output_dir=processing_output_dir,
        visual_debug=visual_debug,
        survey_number=survey_number,
        transaction_limit=transaction_limit,
        logger=logger,
    )
    try:
        for item in gen:
            # Yield as a JSON line
            yield json.dumps(item) + "\n"
    except Exception as e:
        yield json.dumps({"type": "error", "message": str(e)}) + "\n"


async def handle_validate_json(request: Request, body: WorkflowRequest):
    """
    Handles JSON-based validation requests (for local_path type).
    This maintains backward compatibility with existing JSON API calls.
    """
    if body.type != "local_path":
        raise HTTPException(
            status_code=400,
            detail="JSON requests only support type='local_path'. Use multipart/form-data for type='files'",
        )

    logger = request.state.logger
    start_time = time.time()
    logger.log_request(body.model_dump())

    processing_id = request.state.request_id
    processing_output_dir = os.path.join("outputs", "validate", processing_id)
    os.makedirs(processing_output_dir, exist_ok=True)

    # Validate paths exist
    if not body.ec_pdf_path:
        raise HTTPException(status_code=400, detail="ec_pdf_path is required")
    if not body.registration_docs_dir:
        raise HTTPException(status_code=400, detail="registration_docs_dir is required")

    if not os.path.exists(body.ec_pdf_path):
        raise HTTPException(
            status_code=400, detail=f"EC PDF not found at {body.ec_pdf_path}"
        )
    if not os.path.exists(body.registration_docs_dir):
        raise HTTPException(
            status_code=400,
            detail=f"Registration docs dir not found at {body.registration_docs_dir}",
        )

    try:
        if body.stream:
            response = StreamingResponse(
                stream_generator(
                    ec_pdf_path=body.ec_pdf_path,
                    registration_docs_dir=body.registration_docs_dir,
                    processing_id=processing_id,
                    processing_output_dir=processing_output_dir,
                    visual_debug=body.visual_debug,
                    transaction_limit=body.transaction_limit,
                    logger=logger,
                ),
                media_type="application/x-ndjson",
            )
            duration = (time.time() - start_time) * 1000
            logger.log_output(
                duration_ms=duration, success=True, data={"request_id": processing_id}
            )
            return response

        result = run_workflow_sync(
            ec_pdf_path=body.ec_pdf_path,
            registration_docs_dir=body.registration_docs_dir,
            processing_id=processing_id,
            processing_output_dir=processing_output_dir,
            visual_debug=body.visual_debug,
            transaction_limit=body.transaction_limit,
            logger=logger,
        )

        duration = (time.time() - start_time) * 1000
        logger.log_output(duration_ms=duration, success=True, data=result)
        return result

    except HTTPException as e:
        duration = (time.time() - start_time) * 1000
        logger.log_error(str(e.detail))
        logger.log_output(
            duration_ms=duration, success=False, data={"request_id": processing_id}
        )
        raise e
    except Exception as e:
        duration = (time.time() - start_time) * 1000
        logger.log_error(str(e))
        logger.log_output(
            duration_ms=duration, success=False, data={"request_id": processing_id}
        )
        raise HTTPException(status_code=500, detail=str(e))


def _register_documents_for_parcel(parcel_id: str, request_id: str, ec_path: str, deeds_dir: Optional[str]):
    """Registers the EC and extracted Sale Deeds in the LandwiseDocument table."""
    db = SessionLocal()
    try:
        # 0. Update Parcel's last_analysis_request_id
        parcel = db.query(Parcel).filter_by(id=parcel_id).first()
        if parcel:
            parcel.last_analysis_request_id = request_id
            db.commit()

        # 1. Register EC — if it already exists, mark extraction complete.
        if ec_path and os.path.exists(ec_path):
            ec_name = os.path.basename(ec_path)
            existing = db.query(LandwiseDocument).filter_by(parcel_id=parcel_id, original_filename=ec_name).first()
            if existing:
                existing.extraction_status = 'completed'
                existing.document_type = existing.document_type or 'EC'
            else:
                with open(ec_path, 'rb') as f:
                    file_content = f.read()
                ec_doc = LandwiseDocument(
                    id=str(uuid.uuid4()),
                    parcel_id=parcel_id,
                    document_type='EC',
                    original_filename=ec_name,
                    storage_key=ec_path,
                    file_content=file_content,
                    extraction_status='completed'
                )
                db.add(ec_doc)

        # 2. Register Deeds — mark any pre-existing rows as 'completed' too.
        print(f"[*] Registering deeds from dir: {deeds_dir}")
        if deeds_dir and os.path.isdir(deeds_dir):
            pdf_files = [f for f in os.listdir(deeds_dir) if f.lower().endswith('.pdf')]
            print(f"[*] Found {len(pdf_files)} PDF files in deeds_dir")
            for f in pdf_files:
                existing_deed = db.query(LandwiseDocument).filter_by(parcel_id=parcel_id, original_filename=f).first()
                if existing_deed:
                    if existing_deed.extraction_status != 'completed':
                        existing_deed.extraction_status = 'completed'
                    continue
                file_full_path = os.path.join(deeds_dir, f)
                if os.path.exists(file_full_path):
                    try:
                        with open(file_full_path, 'rb') as df:
                            deed_content = df.read()
                        deed_doc = LandwiseDocument(
                            id=str(uuid.uuid4()),
                            parcel_id=parcel_id,
                            document_type='SALE_DEED',
                            original_filename=f,
                            storage_key=file_full_path,
                            file_content=deed_content,
                            extraction_status='completed'
                        )
                        db.add(deed_doc)
                        print(f"[+] Registered deed: {f} -> {file_full_path} ({len(deed_content)} bytes)")
                    except Exception as e:
                        print(f"[!] Failed to register deed {f}: {e}")
                else:
                    print(f"[!] File not found, skipping: {file_full_path}")
        
        db.commit()
    except Exception as e:
        print(f"[!] Error registering documents in DB: {e}")
        db.rollback()
    finally:
        db.close()


async def persist_forensic_results_to_db(parcel_id: str, request_id: str, output_dir: str):
    """
    Parses output JSON files and populates all forensic tables in DB.
    """
    db = SessionLocal()
    try:
        print(f"[*] Persisting analysis results to DB for request: {request_id}")
        
        # 0. Ensure Parcel is linked
        parcel = db.query(Parcel).filter_by(id=parcel_id).first()
        if not parcel: return

        # 1. EC Data (Ownership Transfers & Encumbrances)
        ec_json_path = os.path.join(output_dir, "ec_final.json")
        if os.path.exists(ec_json_path):
            with open(ec_json_path, 'r', encoding='utf-8') as f:
                ec_data = json.load(f)
                # Clear old data for fresh re-audit if needed, or rely on request_id logic
                # For now, we append/sync.
                for entry in ec_data:
                    nature = entry.get("nature_of_document", "").lower()
                    doc_no = entry.get("document_number")
                    
                    # Store in AnalysisResult for raw access
                    ar_ec = AnalysisResult(
                        parcel_id=parcel_id,
                        request_id=request_id,
                        result_type='ec_entry',
                        data=entry
                    )
                    db.add(ar_ec)

                    if any(term in nature for term in ['mortgage', 'loan', 'charge', 'attachment', 'bail']):
                        # Encumbrance — model columns are
                        # encumbrance_type / holder_name / amount /
                        # created_date / status.
                        nature_str = (entry.get("nature_of_document") or "").lower()
                        enc_type = "mortgage"
                        for kw, mapped in (
                            ("lien", "lien"), ("easement", "easement"),
                            ("attachment", "attachment"), ("court", "court_order"),
                            ("acquisition", "government_acquisition"), ("lease", "lease"),
                        ):
                            if kw in nature_str:
                                enc_type = mapped
                                break

                        enc_date = entry.get("date")
                        try:
                            from api.validate.matcher import _parse_ec_date
                            if isinstance(enc_date, str):
                                dt = _parse_ec_date(enc_date)
                                enc_date = dt.date() if dt != datetime.min else None
                        except Exception:
                            enc_date = None

                        amt = entry.get("consideration")
                        if isinstance(amt, str):
                            digits = re.sub(r"[^\d.]", "", amt)
                            amt = float(digits) if digits else None

                        buyers = entry.get("buyers") or []
                        holder_name = buyers[0] if buyers else "Unknown"

                        enc = Encumbrance(
                            id=str(uuid.uuid4()),
                            parcel_id=parcel_id,
                            encumbrance_type=enc_type,
                            holder_name=str(holder_name),
                            amount=amt,
                            created_date=enc_date,
                            status='active',
                        )
                        db.add(enc)
                    else:
                        # Ownership Transfer — model columns are
                        # transfer_type/registration_number/registration_date
                        # /consideration_amount; we don't resolve owner ids here.
                        nature = (entry.get("nature_of_document") or "").lower()
                        transfer_type = "sale"
                        for kw, mapped in (
                            ("gift", "gift"), ("partition", "partition"),
                            ("inheritance", "inheritance"), ("court", "court_order"),
                            ("acquisition", "government_acquisition"),
                        ):
                            if kw in nature:
                                transfer_type = mapped
                                break

                        reg_date = entry.get("date")
                        try:
                            from api.validate.matcher import _parse_ec_date
                            if isinstance(reg_date, str):
                                dt = _parse_ec_date(reg_date)
                                reg_date = dt.date() if dt != datetime.min else None
                        except Exception:
                            reg_date = None

                        consideration = entry.get("consideration")
                        if isinstance(consideration, str):
                            digits = re.sub(r"[^\d.]", "", consideration)
                            consideration = float(digits) if digits else None

                        ot = OwnershipTransfer(
                            id=str(uuid.uuid4()),
                            parcel_id=parcel_id,
                            transfer_type=transfer_type,
                            registration_number=str(doc_no) if doc_no else None,
                            registration_date=reg_date,
                            consideration_amount=consideration,
                        )
                        db.add(ot)

        # 2. Hierarchy Tree
        h_json_path = os.path.join(output_dir, "hierarchy_tree.json")
        if os.path.exists(h_json_path):
            with open(h_json_path, 'r', encoding='utf-8') as f:
                h_data = json.load(f)
                ar_h = AnalysisResult(
                    parcel_id=parcel_id,
                    request_id=request_id,
                    result_type='hierarchy_tree',
                    data=h_data
                )
                db.add(ar_h)

        # 3. Validation Results (Consistency Checks)
        final_result_path = os.path.join(output_dir, "final_result.json")
        if os.path.exists(final_result_path):
            with open(final_result_path, 'r', encoding='utf-8') as f:
                final_data = json.load(f)

                # Snapshot per-parcel counts immediately so /stats reads the
                # right values before the user (or a refresh) triggers the
                # risk-score endpoint.
                all_results = final_data.get("results", []) or []
                _matched = sum(1 for r in all_results if r.get("match") or r.get("validation_result", {}).get("match"))
                _trust_scores = [
                    r.get("validation_result", {}).get("trustability_score")
                    for r in all_results
                ]
                _trust_scores = [t for t in _trust_scores if isinstance(t, (int, float))]
                _avg_trust = (sum(_trust_scores) / len(_trust_scores)) if _trust_scores else 0
                _scrutiny = sum(1 for t in _trust_scores if t < 70)
                parcel.total_docs_count = len(all_results)
                parcel.passed_docs_count = _matched
                parcel.avg_trustability_score = round(_avg_trust, 2)
                parcel.scrutiny_docs_count = _scrutiny

                # Create a ConsistencyCheck master record
                cc_master = ConsistencyCheck(
                    id=str(uuid.uuid4()),
                    parcel_id=parcel_id,
                    status='completed',
                    total_fields_checked=len(all_results),
                    mismatch_count=sum(1 for r in all_results if not r.get("validation_result", {}).get("match")),
                    completed_at=datetime.utcnow()
                )
                db.add(cc_master)

                for res in final_data.get("results", []):
                    doc_no = res.get("document_number")
                    v_res = res.get("validation_result", {})
                    
                    # Link to LandwiseDocument
                    doc_rec = db.query(LandwiseDocument).filter_by(parcel_id=parcel_id, original_filename=res.get("filename")).first()
                    
                    if doc_rec and not v_res.get("match"):
                        # Log Mismatches
                        for comp in v_res.get("comparisons", []):
                            if comp.get("status") != "MATCHED":
                                mm = ConsistencyMismatch(
                                    id=str(uuid.uuid4()),
                                    check_id=cc_master.id,
                                    field_key=comp.get("field"),
                                    doc_a_id=doc_rec.id, # Using same doc for now as placeholder for mismatch UI
                                    doc_a_value=str(comp.get("metadata_value")),
                                    doc_b_id=doc_rec.id,
                                    doc_b_value=str(comp.get("ec_value")),
                                    severity='error' if comp.get("status") == "CRITICAL_MISMATCH" else 'warning',
                                    lawyer_note=comp.get("reason")
                                )
                                db.add(mm)

                    # Create RiskFlag entries — high severity on a failed
                    # match, medium on a low trustability score even when
                    # match passed.
                    trust_score = v_res.get("trustability_score")
                    if not v_res.get("match"):
                        db.add(RiskFlag(
                            id=str(uuid.uuid4()),
                            parcel_id=parcel_id,
                            risk_category='title_defect',
                            severity='high',
                            source='ai_auto',
                            description=(
                                f"Validation failed for Document {doc_no}: "
                                f"{res.get('reason_for_failure') or 'Data mismatch detected between EC and Deed.'}"
                            ),
                            action='pending',
                        ))
                    elif isinstance(trust_score, (int, float)) and trust_score < 70:
                        db.add(RiskFlag(
                            id=str(uuid.uuid4()),
                            parcel_id=parcel_id,
                            risk_category='compliance',
                            severity='medium',
                            source='ai_auto',
                            description=(
                                f"Low trustability score ({trust_score}%) for Document {doc_no}. "
                                "Human review recommended."
                            ),
                            action='pending',
                        ))

                    # Store detailed validation JSON
                    ar_v = AnalysisResult(
                        parcel_id=parcel_id,
                        request_id=request_id,
                        result_type=f'validation_{doc_no.replace("/", "_")}',
                        data=res
                    )
                    db.add(ar_v)

        # 4. Owners and Checklist (Derived from grouped analysis)
        current_owners_summary = await handle_get_survey_ownership(request_id)
        if current_owners_summary.get("status") == "success":
            for own_data in current_owners_summary.get("data", []):
                # Save as Owner record
                new_owner = Owner(
                    id=str(uuid.uuid4()),
                    parcel_id=parcel_id,
                    name=own_data.get("current_owner"),
                    owner_type='individual', # Default
                    is_current_owner=True
                )
                db.add(new_owner)

        db.commit()
        print(f"[+] Persistence complete for request {request_id}")

    except Exception as e:
        print(f"[!] Error persisting forensic results: {e}")
        db.rollback()
    finally:
        db.close()

async def handle_validate(
    request: Request,
    type: str,
    stream: bool = False,
    ec_pdf_path: Optional[str] = None,
    registration_docs_dir: Optional[str] = None,
    ec_pdf_file: Optional[UploadFile] = None,
    sale_deeds_zip: Optional[UploadFile] = None,
    visual_debug: bool = False,
    transaction_limit: Optional[int] = None,
    parcel_id: Optional[str] = None,
    cleanup_dir: Optional[str] = None,
):
    """
    Handles validation workflow with support for both local_path and files input types.

    For type="local_path":
        - ec_pdf_path: path to EC PDF file
        - registration_docs_dir: path to directory containing sale deed PDFs

    For type="files":
        - ec_pdf_file: uploaded EC PDF file
        - sale_deeds_zip: uploaded ZIP file containing sale deed PDFs
    """
    logger = request.state.logger
    start_time = time.time()

    processing_id = request.state.request_id
    # Local scratch only — canonical store is S3 at outputs/validate/<rid>/...
    # The whole tmp/work/<rid>/ tree is rmtree'd at the end of every run.
    _rp = RunPaths(processing_id, kind="validate").ensure()
    processing_output_dir = _rp.output_dir
    processing_input_dir = _rp.input_dir
    s3_output_prefix = _rp.s3_output_prefix
    s3_input_prefix = _rp.s3_input_prefix

    # Determine actual paths based on input type
    actual_ec_pdf_path = None
    actual_registration_docs_dir = None

    ec_content_hash: Optional[str] = None
    zip_content_hash: Optional[str] = None

    if type == "local_path":
        # Validate required fields
        if not ec_pdf_path:
            raise HTTPException(
                status_code=400, detail="ec_pdf_path is required for local_path type"
            )
        if not registration_docs_dir:
            raise HTTPException(
                status_code=400,
                detail="registration_docs_dir is required for local_path type",
            )

        # Validate paths exist
        if not os.path.exists(ec_pdf_path):
            raise HTTPException(
                status_code=400, detail=f"EC PDF not found at {ec_pdf_path}"
            )
        if not os.path.exists(registration_docs_dir):
            raise HTTPException(
                status_code=400,
                detail=f"Registration docs dir not found at {registration_docs_dir}",
            )

        actual_ec_pdf_path = ec_pdf_path
        actual_registration_docs_dir = registration_docs_dir

        # Log request
        logger.log_request(
            {
                "type": type,
                "ec_pdf_path": ec_pdf_path,
                "registration_docs_dir": registration_docs_dir,
                "stream": stream,
                "visual_debug": visual_debug,
                "transaction_limit": transaction_limit,
            }
        )

    elif type == "files":
        # Validate required EC file
        if not ec_pdf_file:
            raise HTTPException(
                status_code=400, detail="ec_pdf_file is required for files type"
            )

        # Save EC PDF to input folder and compute hash
        ec_pdf_filename = ec_pdf_file.filename or "ec.pdf"
        actual_ec_pdf_path = os.path.join(processing_input_dir, ec_pdf_filename)

        ec_bytes = await ec_pdf_file.read()
        with open(actual_ec_pdf_path, "wb") as f:
            f.write(ec_bytes)
        ec_content_hash = hashlib.sha256(ec_bytes).hexdigest()
        try:
            sync_file(
                actual_ec_pdf_path,
                content_type="application/pdf",
                key=f"{s3_input_prefix}/{ec_pdf_filename}",
            )
        except Exception as _e:
            print(f"Input sync (ec upload) failed: {_e}")

        # If a deeds ZIP is provided, process it as before.
        # If not provided, we will run EC-only hierarchy workflow later.
        if sale_deeds_zip:
            zip_path = os.path.join(processing_input_dir, "sale_deeds.zip")
            zip_bytes = await sale_deeds_zip.read()
            with open(zip_path, "wb") as f:
                f.write(zip_bytes)
            zip_content_hash = hashlib.sha256(zip_bytes).hexdigest()

            # Extract ZIP to output directory (pdf_vault) to avoid collision between surveys
            extracted_count = 0
            try:
                # Create a dedicated vault folder for ALL PDFs in the ZIP under outputs
                all_pdfs_repo_dir = os.path.join(processing_output_dir, "pdf_vault")
                os.makedirs(all_pdfs_repo_dir, exist_ok=True)
                print(f"[*] Created pdf_vault at: {all_pdfs_repo_dir}")
                
                with zipfile.ZipFile(zip_path, "r") as zip_ref:
                    print(f"[*] ZIP contains {len(zip_ref.infolist())} members")
                    for member in zip_ref.infolist():
                        # Handle potential encoding issues with filenames in ZIPs
                        try:
                            filename = member.filename.encode('cp437').decode('utf-8')
                        except:
                            filename = member.filename
                        
                        # Extract only if it's a file
                        if not member.is_dir():
                            target_filename = os.path.basename(filename)
                            if target_filename:
                                # Always store in pdf_vault first
                                repo_target_path = os.path.join(all_pdfs_repo_dir, target_filename)
                                try:
                                    with zip_ref.open(member) as source, open(repo_target_path, "wb") as target:
                                        shutil.copyfileobj(source, target)
                                    print(f"[+] Extracted: {target_filename} -> {repo_target_path}")
                                    extracted_count += 1
                                    
                                    # Also keep a copy in the root input dir for backward compatibility
                                    root_target_path = os.path.join(processing_input_dir, target_filename)
                                    try:
                                        shutil.copy2(repo_target_path, root_target_path)
                                    except Exception as e:
                                        print(f"[!] Failed to copy to input dir (non-critical): {e}")
                                except Exception as e:
                                    print(f"[!] Failed to extract {target_filename}: {e}")
                
                print(f"[*] Total extracted: {extracted_count} files to {all_pdfs_repo_dir}")

                # List what was actually extracted
                if os.path.isdir(all_pdfs_repo_dir):
                    extracted_files = os.listdir(all_pdfs_repo_dir)
                    print(f"[*] Files in pdf_vault: {extracted_files}")

                # Sync extracted vault (lives under processing_output_dir/pdf_vault
                # in scratch) and the input copies to their canonical S3 prefixes.
                try:
                    sync_dir(all_pdfs_repo_dir, key_prefix=f"{s3_output_prefix}/pdf_vault")
                    sync_dir(processing_input_dir, key_prefix=s3_input_prefix)
                except Exception as _e:
                    print(f"Input sync (zip extract) failed: {_e}")
            except zipfile.BadZipFile:
                raise HTTPException(status_code=400, detail="Invalid ZIP file provided")
            except Exception as e:
                print(f"[!] ZIP extraction error: {e}")
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"ZIP extraction failed: {str(e)}")

            # Smartly determine the registration_docs_dir by finding where PDFs actually are
            # We now point this specifically to our new repository
            actual_registration_docs_dir = all_pdfs_repo_dir

        # Log request
        logger.log_request(
            {
                "type": type,
                "ec_pdf_file": ec_pdf_file.filename,
                "sale_deeds_zip": getattr(sale_deeds_zip, "filename", None),
                "stream": stream,
                "input_dir": processing_input_dir,
                "output_dir": processing_output_dir,
                "transaction_limit": transaction_limit,
            }
        )

    else:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid type: {type}. Must be 'local_path' or 'files'",
        )

    # ---- Cache lookup (whole-workflow result) ----
    cache_key: Optional[str] = None
    cache_entry: Optional[dict] = None

    try:
        if type == "files" and ec_content_hash and zip_content_hash:
            cache_key = _make_cache_key_for_files_hashes(
                ec_content_hash,
                zip_content_hash,
                transaction_limit,
                visual_debug,
            )
        elif type == "local_path":
            cache_key = _make_cache_key_for_local_paths(
                actual_ec_pdf_path,
                actual_registration_docs_dir,
                transaction_limit,
                visual_debug,
            )
    except Exception as e:
        # If cache key computation fails, just log and continue without cache
        logger.log_error(f"Cache key computation failed: {e}")
        cache_key = None

    if cache_key:
        index = _load_cache_index()
        cache_entry = index.get(cache_key)
        if cache_entry and cache_entry.get("pipeline_version") == CACHE_PIPELINE_VERSION:
            # The canonical pointer is an S3 key (legacy entries may still
            # carry a local path under `final_result_path` — we honour both).
            cached_result = None
            final_result_key = cache_entry.get("final_result_key")
            if final_result_key:
                cached_result = read_json(final_result_key, default=None)
            else:
                legacy_path = cache_entry.get("final_result_path")
                if legacy_path and os.path.exists(legacy_path):
                    try:
                        with open(legacy_path, "r", encoding="utf-8") as f:
                            cached_result = json.load(f)
                    except Exception as e:
                        logger.log_error(f"Failed to load legacy cached result: {e}")

            if cached_result is not None:
                cached_rid = cached_result.get("request_id")
                print(f"[*] Cache hit for request_id: {cached_rid}")

                # We don't repopulate any local vault on cache hit. Modules
                # that subsequently need a PDF call storage.local_copy(key)
                # which downloads on-demand to tmp/ and removes it after.
                # _register_documents_for_parcel needs the file bytes; it
                # already handles S3 keys via storage when paths are missing.
                if parcel_id and cached_rid:
                    print(f"[*] Re-registering documents for parcel {parcel_id} from cache-hit path")
                    try:
                        _register_documents_for_parcel(
                            parcel_id, processing_id, actual_ec_pdf_path,
                            f"outputs/validate/{cached_rid}/pdf_vault",
                        )
                    except Exception as e:
                        print(f"[!] Re-register on cache-hit failed (non-fatal): {e}")

                # Cache hit produces nothing new on disk → nothing to sync.
                # Wipe the scratch dirs that handle_validate eagerly created.
                try:
                    _rp.cleanup()
                except Exception as _e:
                    print(f"tmp scratch cleanup (cache-hit) failed: {_e}")

                if stream:
                    def cached_stream():
                        yield json.dumps(
                            {"type": "log",
                             "message": f"Using cached result for request_id={cached_rid}"}
                        ) + "\n"
                        yield json.dumps(
                            {"type": "result", "data": cached_result, "cached": True}
                        ) + "\n"

                    response = StreamingResponse(cached_stream(), media_type="application/x-ndjson")
                    duration = (time.time() - start_time) * 1000
                    logger.log_output(
                        duration_ms=duration, success=True,
                        data={"request_id": cached_rid, "cache_hit": True},
                    )
                    return response

                duration = (time.time() - start_time) * 1000
                logger.log_output(
                    duration_ms=duration, success=True,
                    data={"request_id": cached_rid, "cache_hit": True},
                )
                return cached_result

    # If we reach here, either no cache_key or no usable cache entry.
    # Record the S3 key the result will be uploaded to, so the next cache
    # hit can read it from storage directly.
    if cache_key:
        index = _load_cache_index()
        index[cache_key] = {
            "request_id": processing_id,
            "final_result_key": f"{s3_output_prefix}/final_result.json",
            "created_at": datetime.utcnow().isoformat() + "Z",
            "pipeline_version": CACHE_PIPELINE_VERSION,
        }
        _save_cache_index(index)

    try:
        # If we do not have a registration_docs_dir (no deeds uploaded),
        # run an EC-only workflow: EC extraction + hierarchy generation.
        if not actual_registration_docs_dir:
            # 1) Run EC extraction to generate ec_final.json similar to full workflow
            chunk_size = int(os.getenv("CHUNK_SIZE", 8))
            ec_output_dir = processing_output_dir
            ec_proc = ECProcessor(output_dir=ec_output_dir, chunk_size=chunk_size)
            try:
                gen_ec = ec_proc.process(actual_ec_pdf_path)
                # Exhaust generator to completion, ignoring intermediate logs
                for _ in gen_ec:
                    pass
            except Exception as e:
                duration = (time.time() - start_time) * 1000
                logger.log_error(f"EC-only extraction failed: {e}")
                logger.log_output(
                    duration_ms=duration,
                    success=False,
                    data={"request_id": processing_id, "mode": "ec_only"},
                )
                raise HTTPException(
                    status_code=500,
                    detail=f"EC extraction failed for EC-only workflow: {str(e)}",
                )

            # 2) Generate hierarchy using HierarchyGenerator (will reuse ec_final.json)
            hg = HierarchyGenerator(output_dir=processing_output_dir)
            hierarchy_data = []
            try:
                gen_h = hg.process(
                    actual_ec_pdf_path,
                    matched_docs=None,
                    source_docs_dir=None,
                    limit=transaction_limit,
                )
                while True:
                    _ = next(gen_h)
            except StopIteration as e:
                hierarchy_data = e.value or []
            except Exception as e:
                duration = (time.time() - start_time) * 1000
                logger.log_error(f"EC-only hierarchy generation failed: {e}")
                logger.log_output(
                    duration_ms=duration,
                    success=False,
                    data={"request_id": processing_id, "mode": "ec_only"},
                )
                raise HTTPException(
                    status_code=500,
                    detail=f"Hierarchy generation failed for EC-only workflow: {str(e)}",
                )

            # Ensure hierarchy data was produced
            if not hierarchy_data:
                duration = (time.time() - start_time) * 1000
                logger.log_error("EC-only workflow produced no hierarchy data")
                logger.log_output(
                    duration_ms=duration,
                    success=False,
                    data={"request_id": processing_id, "mode": "ec_only"},
                )
                raise HTTPException(
                    status_code=500,
                    detail="No hierarchy data produced from EC-only workflow",
                )

            final_result = {
                "status": "success",
                "output_dir": processing_output_dir,
                "request_id": processing_id,
                "results": [],
                "hierarchy_path": f"validate/{processing_id}/hierarchy_view.html",
                "mode": "ec_only",
                "hierarchy_nodes": len(hierarchy_data)
                if isinstance(hierarchy_data, list)
                else None,
            }

            duration = (time.time() - start_time) * 1000
            logger.log_output(duration_ms=duration, success=True, data=final_result)
            if parcel_id:
                _register_documents_for_parcel(parcel_id, processing_id, actual_ec_pdf_path, actual_registration_docs_dir)
            return final_result

        if stream:
            # When this run is tied to a parcel, the post-workflow bookkeeping
            # the SYNC path does (register documents + persist forensic results)
            # must still run — but only AFTER the stream is fully consumed, so we
            # hang it off a BackgroundTask. That same task also cleans up the
            # caller's materialized temp dir (cleanup_dir), which must survive
            # until the workflow finishes reading it. Keeping stream_generator a
            # plain sync generator lets FastAPI run it in a threadpool so the
            # multi-minute workflow never blocks the event loop.
            from starlette.background import BackgroundTask

            async def _finalize_stream():
                if parcel_id:
                    try:
                        _register_documents_for_parcel(
                            parcel_id, processing_id, actual_ec_pdf_path, actual_registration_docs_dir
                        )
                    except Exception as e:
                        print(f"[!] stream finalize: register documents failed: {e}")
                    try:
                        await persist_forensic_results_to_db(
                            parcel_id, processing_id, processing_output_dir
                        )
                    except Exception as e:
                        print(f"[!] stream finalize: persist forensic results failed: {e}")
                if cleanup_dir and os.path.exists(cleanup_dir):
                    shutil.rmtree(cleanup_dir, ignore_errors=True)

            response = StreamingResponse(
                stream_generator(
                    ec_pdf_path=actual_ec_pdf_path,
                    registration_docs_dir=actual_registration_docs_dir,
                    processing_id=processing_id,
                    processing_output_dir=processing_output_dir,
                    visual_debug=visual_debug,
                    transaction_limit=transaction_limit,
                    logger=logger,
                ),
                media_type="application/x-ndjson",
                background=BackgroundTask(_finalize_stream),
            )
            duration = (time.time() - start_time) * 1000
            logger.log_output(
                duration_ms=duration, success=True, data={"request_id": processing_id}
            )
            return response

        result = run_workflow_sync(
            ec_pdf_path=actual_ec_pdf_path,
            registration_docs_dir=actual_registration_docs_dir,
            processing_id=processing_id,
            processing_output_dir=processing_output_dir,
            visual_debug=visual_debug,
            transaction_limit=transaction_limit,
            logger=logger,
        )

        duration = (time.time() - start_time) * 1000
        logger.log_output(duration_ms=duration, success=True, data=result)
        if parcel_id:
            _register_documents_for_parcel(parcel_id, processing_id, actual_ec_pdf_path, actual_registration_docs_dir)
            await persist_forensic_results_to_db(parcel_id, processing_id, processing_output_dir)
        sync_ok = True
        try:
            sync_dir(processing_output_dir, key_prefix=s3_output_prefix)
            sync_dir(processing_input_dir, key_prefix=s3_input_prefix)
        except Exception as e:
            sync_ok = False
            print(f"Storage sync failed (non-fatal): {e}")

        # Always wipe the scratch tree — S3 is the source of truth.
        # If the sync failed we keep the scratch around for inspection.
        if sync_ok:
            try:
                _rp.cleanup()
            except Exception as _e:
                print(f"tmp scratch cleanup failed: {_e}")
        else:
            print(f"[!] Storage sync failed — keeping local scratch at {_rp.output_dir} for recovery")
        return result

    except HTTPException as e:
        duration = (time.time() - start_time) * 1000
        logger.log_error(str(e.detail))
        logger.log_output(
            duration_ms=duration, success=False, data={"request_id": processing_id}
        )
        raise e
    except Exception as e:
        duration = (time.time() - start_time) * 1000
        logger.log_error(str(e))
        logger.log_output(
            duration_ms=duration, success=False, data={"request_id": processing_id}
        )
        raise HTTPException(status_code=500, detail=str(e))

async def handle_analyze_ec(request: Request, ec_pdf_path: str = None, ec_pdf_file: UploadFile = None, request_id: str = None):
    """
    Handles specialized EC analysis for historical property values.
    Scratch in tmp/work/, canonical state in S3 at outputs/analyze/<rid>/.
    """
    logger = request.state.logger
    processing_id = request_id or str(uuid.uuid4())
    _rp_analyze = RunPaths(processing_id, kind="analyze").ensure()
    processing_output_dir = _rp_analyze.output_dir
    s3_output_prefix_analyze = _rp_analyze.s3_output_prefix
    s3_input_prefix_analyze = _rp_analyze.s3_input_prefix

    actual_path = ec_pdf_path

    # CASE 1: File Uploaded
    if ec_pdf_file:
        input_dir = _rp_analyze.input_dir
        actual_path = os.path.join(input_dir, ec_pdf_file.filename)
        with open(actual_path, "wb") as f:
            content = await ec_pdf_file.read()
            f.write(content)
        try:
            sync_file(
                actual_path,
                content_type="application/pdf",
                key=f"{s3_input_prefix_analyze}/{ec_pdf_file.filename}",
            )
        except Exception as _e:
            print(f"Input sync (analyze) failed: {_e}")
    
    # CASE 2: No path but Request ID provided — fetch a prior validate run's
    # EC PDF from S3 (it lives under inputs/validate/<rid>/). Download a copy
    # into this analyze run's tmp scratch.
    elif not actual_path and request_id:
        storage = get_storage()
        prior_input_prefix = f"inputs/validate/{request_id}"
        candidate_keys = [k for k in storage.list_prefix(prior_input_prefix) if k.lower().endswith(".pdf")]
        if not candidate_keys:
            raise HTTPException(status_code=400, detail=f"No EC PDF found in storage for request {request_id}")
        chosen_key = candidate_keys[0]
        actual_path = os.path.join(_rp_analyze.input_dir, os.path.basename(chosen_key))
        os.makedirs(os.path.dirname(actual_path), exist_ok=True)
        storage.download_to(chosen_key, actual_path)

    if not actual_path or not os.path.exists(actual_path):
        raise HTTPException(status_code=400, detail="EC PDF file/path is required")

    ec_proc = ECProcessor(output_dir=processing_output_dir)

    results = []
    # Run the generator to completion
    gen = ec_proc.analyze_historical_values(actual_path)
    try:
        while True:
            item = next(gen)
            if isinstance(item, str):
                print(f"[*] {item}")
    except StopIteration as e:
        results = e.value

    sync_ok = True
    try:
        sync_dir(processing_output_dir, key_prefix=s3_output_prefix_analyze)
    except Exception as _e:
        sync_ok = False
        print(f"Output sync (analyze) failed: {_e}")

    if sync_ok:
        try:
            _rp_analyze.cleanup()
        except Exception as _e:
            print(f"tmp scratch cleanup (analyze) failed: {_e}")

    return {
        "status": "success",
        "request_id": processing_id,
        "processed_at": time.time(),
        "data": results,
        "output_file": f"analyze/{processing_id}/ec_historical_values.json"
    }

async def handle_verify_supporting_doc(supporting_file: UploadFile, deed_metadata_json: str):
    """
    Handles verification of a supporting document against deed metadata.
    """
    temp_dir = "tmp/supporting_verify"
    os.makedirs(temp_dir, exist_ok=True)
    
    file_path = os.path.join(temp_dir, supporting_file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(supporting_file.file, buffer)
    
    try:
        deed_metadata = json.loads(deed_metadata_json)
        verifier = SupportingVerifier(output_dir=temp_dir)
        result = verifier.verify(deed_metadata, file_path)
        return result
    finally:
        # Cleanup
        if os.path.exists(file_path):
            os.remove(file_path)

def _resolve_vault_doc_to_path(document_id: str, doc_no: str) -> Optional[str]:
    """
    Looks up a LandwiseDocument by id. If its storage_key file exists, return it.
    Otherwise, materialize file_content (DB-stored bytes) to a temp file and return that path.
    """
    import os, re, tempfile
    try:
        from common.database import SessionLocal
        from common.landwise_models import LandwiseDocument
    except Exception as e:
        print(f"[!] vault resolve failed (import): {e}")
        return None

    db = None
    try:
        db = SessionLocal()
        doc = db.query(LandwiseDocument).filter(LandwiseDocument.id == document_id).first()
        if not doc:
            print(f"[!] vault resolve: document {document_id} not in DB")
            return None
        if doc.storage_key and os.path.exists(doc.storage_key):
            return doc.storage_key
        if doc.file_content:
            safe_name = re.sub(r'[^a-zA-Z0-9]', '_', str(doc_no)) + ".pdf"
            cache_dir = os.path.join("outputs", "storage", "vault_cache")
            os.makedirs(cache_dir, exist_ok=True)
            cache_path = os.path.join(cache_dir, f"{document_id}_{safe_name}")
            if not os.path.exists(cache_path) or os.path.getsize(cache_path) != len(doc.file_content):
                with open(cache_path, "wb") as f:
                    f.write(doc.file_content)
            return cache_path
        return None
    except Exception as e:
        print(f"[!] vault resolve failed: {e}")
        return None
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass


def resolve_pdf_path(doc_no: str, request_id: Optional[str] = None, hint: Optional[str] = None) -> Optional[str]:
    """
    Robustly resolves the absolute path to a document's PDF.
    Searches:
    1. Hint path (sanitized) - including vault download URLs
    2. Request-specific outputs
    3. Request-specific inputs
    4. Global vault
    """
    import os, re

    # Normalizer for filenames
    safe_name = re.sub(r'[^a-zA-Z0-9]', '_', str(doc_no)) + ".pdf"

    # 1. Try hint first if provided
    if hint:
        # 1a. Vault download URL? (e.g. http://localhost:8000/api/v1/landwise/documents/download/<uuid>)
        m = re.search(r"/landwise/documents/download/([0-9a-fA-F\-]{36})", hint)
        if m:
            vault_path = _resolve_vault_doc_to_path(m.group(1), doc_no)
            if vault_path:
                return vault_path

        # 1b. download-by-path URL? (e.g. .../landwise/documents/download-by-path?file_path=...)
        m2 = re.search(r"/landwise/documents/download-by-path\?file_path=([^&]+)", hint)
        if m2:
            from urllib.parse import unquote
            inner = unquote(m2.group(1))
            for c in [inner, os.path.join("outputs", inner), os.path.join("inputs", inner)]:
                if c and (os.path.exists(c) or ensure_local(c)):
                    return c

        cleaned = hint
        # Remove common URL/Mount prefixes
        for pfx in ["/files/", "files/", "../input-files/", "input-files/"]:
            if cleaned.startswith(pfx):
                cleaned = cleaned[len(pfx):]
                break

        candidates = [
            os.path.join("outputs", cleaned),
            os.path.join("inputs", cleaned),
            cleaned if os.path.isabs(cleaned) else None
        ]
        for c in candidates:
            if c and (os.path.exists(c) or ensure_local(c)):
                return c

    # 2. Try request-specific locations
    if request_id:
        req_candidates = [
            os.path.join("outputs", "validate", request_id, "matched_docs", safe_name),
            os.path.join("outputs", "validate", request_id, safe_name),
            os.path.join("inputs", "validate", request_id, "sale_deeds", safe_name),
            os.path.join("inputs", "validate", request_id, safe_name),
            os.path.join("inputs", "validate", request_id, f"{doc_no.replace('/', '_')}.pdf")
        ]
        for c in req_candidates:
            if os.path.exists(c) or ensure_local(c):
                return c

    # 3. Try Global Vault
    vault_path = os.path.join("outputs", "storage", "vault", safe_name)
    if os.path.exists(vault_path) or ensure_local(vault_path):
        return vault_path

    # 4. Last-resort: scan vault DB by filename match
    try:
        from common.database import SessionLocal
        from common.landwise_models import LandwiseDocument
        db = SessionLocal()
        try:
            target = re.sub(r'[\s\-_/\\]', '', str(doc_no)).lower()
            if target:
                docs = db.query(LandwiseDocument).all()
                for d in docs:
                    fn_norm = re.sub(r'[\s\-_/\\]', '', d.original_filename or '').lower()
                    if target in fn_norm:
                        resolved = _resolve_vault_doc_to_path(d.id, doc_no)
                        if resolved:
                            return resolved
        finally:
            db.close()
    except Exception as e:
        print(f"[!] vault filename scan failed: {e}")

    return None

def _normalize_docno(s) -> str:
    """Collapse a document number to digits+letters for tolerant matching
    ("3765/2008" -> "37652008", "266-2009" -> "2662009")."""
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def _read_ec_raw_text(request_id: Optional[str]) -> str:
    """
    Return the EC raw OCR text for an analyze run, stripped of the
    `# OCR_VERSION=N` header, or "" if unavailable. Tries local scratch
    first, then pulls from the storage backend via ensure_local — same
    three-tier shape resolve_pdf_path uses for PDFs.
    """
    if not request_id:
        return ""
    path = os.path.join("outputs", "validate", request_id, "ec_raw_full.txt")
    if not os.path.exists(path):
        try:
            ensure_local(path)
        except Exception:
            pass
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return ""
    return re.sub(r"^#\s*OCR_VERSION=\d+\s*\n", "", raw)


def _find_ec_entries_for_doc(ec_data, doc_no):
    """EC transaction entries whose document_number matches doc_no."""
    target = _normalize_docno(doc_no)
    if not target or not isinstance(ec_data, list):
        return []
    return [
        e for e in ec_data
        if isinstance(e, dict) and _normalize_docno(e.get("document_number")) == target
    ]


def _sanitize_chat_response(text: str) -> str:
    """
    Clean LLM output for the chat UI. DocChat renders with ReactMarkdown and
    NO math/GFM-table plugins, so LaTeX the model occasionally emits
    ($$...$$, \\text{}, \\quad, \\big|) leaks through as raw symbols (exactly
    the "$$\\text{Date of Execution}...$$" the user saw). Strip those to plain
    text and tidy whitespace. Currency is left untouched (we only unwrap the
    $$...$$ block form, never single-$).
    """
    if not text:
        return text
    s = text
    # Unwrap $$ ... $$ block math, keeping the inner content.
    s = re.sub(r"\$\$(.+?)\$\$", r"\1", s, flags=re.S)
    # Common LaTeX tokens -> plain text.
    s = re.sub(r"\\(?:text|mathrm|mathbf|textbf)\s*\{([^}]*)\}", r"\1", s)
    s = s.replace(r"\quad", "   ").replace(r"\big|", "|").replace(r"\mid", "|")
    s = s.replace(r"\,", " ").replace(r"\;", " ").replace(r"\:", " ")
    s = re.sub(r"\\\\", " ", s)          # stray LaTeX line-breaks
    # Collapse 3+ newlines so answers stay compact.
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


async def handle_chat_with_doc(
    doc_no: str,
    message: str,
    history: list = None,
    request_id: Optional[str] = None,
    parcel_id: Optional[str] = None,
):
    """
    Answer a chat question about a specific document.

    Primary source is the property's already-EXTRACTED EC data
    (ec_final.json + ec_raw_full.txt) for the analyze run. This is what the
    user asked for — "use the EC json for the check, not the pdf vault" — and
    it has two payoffs:
      * Speed: no PDF re-upload + Gemini vision-OCR on every message; we send
        compact extracted text/JSON and answer in ~1-3s.
      * Comparison: the assistant sees the WHOLE encumbrance chain, so it can
        check whether this document appears in the EC and whether its details
        line up with the surrounding transactions.

    Falls back to reading the document PDF directly only when no EC artifacts
    exist, and degrades to a friendly message rather than a 404/500 so the
    chat panel never shows a hard error.
    """
    import asyncio
    from common.gemini_helper import GeminiHelper
    from services.artifact_store import read_json_artifact

    # ---- Build context from already-extracted EC data ------------------
    ec_data = read_json_artifact(request_id, "ec_final.json") if request_id else None
    # Tolerate the dict-envelope shape an intermediate build briefly used.
    if isinstance(ec_data, dict) and isinstance(ec_data.get("data"), list):
        ec_data = ec_data["data"]
    if not isinstance(ec_data, list):
        ec_data = []

    raw_text = _read_ec_raw_text(request_id)
    matched_entries = _find_ec_entries_for_doc(ec_data, doc_no)

    if ec_data or raw_text:
        print(f"[*] Chatting with EC data for {doc_no} (request {request_id}, "
              f"{len(ec_data)} entries, matched={len(matched_entries)})")

        context_parts = []
        if matched_entries:
            context_parts.append(
                f"### EC ENTRY FOR THIS DOCUMENT (Doc No: {doc_no})\n"
                + json.dumps(matched_entries, ensure_ascii=False, indent=2)
            )
        else:
            context_parts.append(
                f"### NOTE\nNo EC entry's document number is an exact match for "
                f"{doc_no}. It may appear under a slightly different serial/year — "
                f"check the full list of entries below before concluding it is absent."
            )
        if ec_data:
            context_parts.append(
                "### ALL EC ENTRIES (the encumbrance chain — use for cross-checking and comparison)\n"
                + json.dumps(ec_data, ensure_ascii=False, indent=2)
            )
        if raw_text:
            # Cap the raw OCR to keep chat latency low on very large ECs; the
            # structured entries above already carry the key fields.
            context_parts.append("### EC RAW EXTRACTED TEXT\n" + raw_text[:150000])
        context = "\n\n".join(context_parts)

        instructions = f"""You are an expert Indian Property Legal Assistant for LandwiseAI.
You are answering questions about document **{doc_no}** using the property's
Encumbrance Certificate (EC) extracted data provided to you. The EC is the chain
of registered transactions for this property.

Use the data to:
- Answer questions about this specific document ({doc_no}).
- CHECK / COMPARE this document against the EC: whether it appears in the EC and
  whether its details (parties, survey number, extent, dates, consideration) are
  consistent with the EC record and the surrounding transactions.

Rules:
1. Base your answer ONLY on the EC data provided — never invent facts.
2. If something is not present in the data, say so plainly.
3. Cite transactions by their EC Document No and Date (e.g. "Doc 3765/2008").
4. Keep Tamil names in the original script; add a transliteration/translation where helpful.
5. Respond in clear Markdown.
6. Be concise and direct: lead with the answer in 1-2 sentences, then only the
   supporting details that matter. Do not restate the question or pad the reply.
7. Use plain GitHub Markdown only — short **bold** labels and "- " bullet lists.
   Do NOT use LaTeX/math notation ($$, \\text{{}}, \\quad, \\big|) and do NOT use
   Markdown tables (the chat UI renders neither). For the Tamil Nadu three-date
   field, write it inline as "Execution | Presentation | Registration".

Chat History:
{json.dumps(history if history else [], ensure_ascii=False, indent=2)}

User Question: {message}
"""
        try:
            gemini = GeminiHelper(model_id="gemini-3.5-flash")  # flash = large context
            # Run the blocking SDK call off the event loop so the API stays responsive.
            response = await asyncio.to_thread(
                gemini.generate_from_text, context, instructions
            )
            return {"response": _sanitize_chat_response(response)}
        except Exception as e:
            print(f"[!] EC-context chat failed for {doc_no}: {e} — trying PDF fallback")
            # fall through to the PDF path below

    # ---- Fallback: read the document PDF directly (legacy path) --------
    file_path = resolve_pdf_path(doc_no, request_id=request_id)
    if not file_path:
        print(f"[!] No EC data and no PDF for chat: {doc_no} (request {request_id})")
        return {
            "response": (
                f"⚠️ I couldn't find extracted EC data or a document file for "
                f"**{doc_no}**. Please run the analysis for this property first, "
                f"then ask again."
            )
        }

    print(f"[*] Chatting with PDF (fallback): {file_path}")
    gemini = GeminiHelper(model_id="gemini-3.5-flash")  # flash for large context

    context_prompt = f"""
    You are an expert Indian Property Legal Assistant.
    You are answering questions about the enclosed land registration document (Document No: {doc_no}).

    Rules:
    1. Base your answers ONLY on the provided document.
    2. If the information is not in the document, say so.
    3. Use a helpful, professional tone.
    4. Format your response in Markdown.
    5. Translate Tamil names or terms where helpful but retain original names for accuracy.

    CRITICAL CITATION RULES:
    - You MUST cite the page number for every piece of information you provide.
    - Use the format [[Page:X]] for citations, where X is the page number.
    - Example: "The executant of this deed is John Doe [[Page:2]]."
    - If information spans multiple pages, cite them like [[Page:2,3]].

    Chat History:
    {json.dumps(history if history else [], indent=2)}

    User Question: {message}
    """

    try:
        response = await asyncio.to_thread(
            gemini.generate_from_file, file_path, context_prompt, f"Deed_{doc_no}"
        )
        return {"response": _sanitize_chat_response(response)}
    except Exception as e:
        return {
            "response": (
                "⚠️ Sorry, I hit an error reading this document. "
                f"Please try again. ({e})"
            )
        }


async def handle_chat_overall(
    message: str,
    history: list = None,
    request_id: Optional[str] = None,
    parcel_id: Optional[str] = None,
    mentions: Optional[list] = None,
):
    """
    Property-wide ("overall") chat. Answers over the WHOLE encumbrance chain for
    an analyze run rather than a single document, so the user can ask
    cross-document questions from one place. When the user @-mentions specific
    document numbers, those entries are surfaced as FOCUSED context on top of the
    full chain (the assistant can still compare against everything else).

    Same fast, PDF-free path as handle_chat_with_doc: reads the already-extracted
    ec_final.json + ec_raw_full.txt and answers with generate_from_text.
    """
    import asyncio
    from common.gemini_helper import GeminiHelper
    from services.artifact_store import read_json_artifact

    ec_data = read_json_artifact(request_id, "ec_final.json") if request_id else None
    if isinstance(ec_data, dict) and isinstance(ec_data.get("data"), list):
        ec_data = ec_data["data"]
    if not isinstance(ec_data, list):
        ec_data = []

    raw_text = _read_ec_raw_text(request_id)

    if not (ec_data or raw_text):
        return {
            "response": (
                "⚠️ I couldn't find extracted EC data for this property yet. "
                "Please run the analysis first, then ask again."
            )
        }

    # Resolve @-mentioned documents to their EC entries (focused context).
    mentions = [m for m in (mentions or []) if str(m).strip()]
    focused = []
    seen_focus = set()
    for m in mentions:
        for e in _find_ec_entries_for_doc(ec_data, m):
            key = _normalize_docno(e.get("document_number"))
            if key and key not in seen_focus:
                seen_focus.add(key)
                focused.append(e)

    context_parts = []
    if focused:
        context_parts.append(
            "### FOCUSED DOCUMENTS (the user @-mentioned these — prioritize them)\n"
            + json.dumps(focused, ensure_ascii=False, indent=2)
        )
    elif mentions:
        context_parts.append(
            "### NOTE\nThe user mentioned " + ", ".join(str(m) for m in mentions)
            + " but no exact EC entry matched. Check the full chain below before "
            "concluding they are absent."
        )
    if ec_data:
        context_parts.append(
            "### ALL EC ENTRIES (the full encumbrance chain for this property)\n"
            + json.dumps(ec_data, ensure_ascii=False, indent=2)
        )
    if raw_text:
        context_parts.append("### EC RAW EXTRACTED TEXT\n" + raw_text[:150000])
    context = "\n\n".join(context_parts)

    mention_line = (
        f"\nThe user is asking specifically about: "
        f"{', '.join(str(m) for m in mentions)}.\n" if mentions else ""
    )

    instructions = f"""You are an expert Indian Property Legal Assistant for LandwiseAI.
You are answering questions about an ENTIRE property using its Encumbrance
Certificate (EC) data — the full chain of registered transactions below.
{mention_line}
Use the data to answer the question and to CHECK / COMPARE across the chain
(ownership flow, whether a document appears, whether parties / survey / extent /
dates / consideration are consistent between transactions).

Rules:
1. Base your answer ONLY on the EC data provided — never invent facts.
2. If something is not present in the data, say so in one short bullet.
3. Cite transactions by their EC Document No (e.g. "Doc 3765/2008").
4. Keep Tamil names in the original script.
5. ALWAYS answer as a SHORT bulleted list. Start every line with "- ".
   Never write paragraphs. No intro sentence, no closing summary, do not
   restate the question.
6. KEEP IT SMALL: at most 5 bullets, each ONE short sentence (~15 words or
   fewer). If the answer is a simple yes/no, give one bullet plus at most two
   supporting bullets.
7. Use SIMPLE, everyday words anyone can understand — write for a normal person,
   not a lawyer. Avoid legal jargon; if a legal term is unavoidable (e.g. "lis
   pendens", "encumbrance"), add a 2-3 word plain meaning in brackets, e.g.
   "lis pendens (a pending court case)".
8. Use plain GitHub Markdown only — "- " bullets and short **bold** labels.
   Do NOT use LaTeX/math notation ($$, \\text{{}}, \\quad, \\big|) and do NOT use
   Markdown tables. For the Tamil Nadu three-date field, write it inline as
   "Execution | Presentation | Registration".

Chat History:
{json.dumps(history if history else [], ensure_ascii=False, indent=2)}

User Question: {message}
"""

    try:
        gemini = GeminiHelper(model_id="gemini-3.5-flash")
        response = await asyncio.to_thread(
            gemini.generate_from_text, context, instructions
        )
        return {"response": _sanitize_chat_response(response)}
    except Exception as e:
        print(f"[!] Overall chat failed (request {request_id}): {e}")
        return {"response": "⚠️ Sorry, I hit an error answering that. Please try again."}


async def handle_mark_ec(request_id: str, parcel_id: str, doc_no: str, mismatches: list):
    """
    Run the visual debugger on the PARCEL'S EC PDF to box the mismatched
    ec_values for a given deed — producing a marked EC PDF so the user can see
    the conflicting value highlighted on the EC, side-by-side with the deed.

    `mismatches` is supplied by the client from the already-loaded comparison
    data: [{ "field": str, "value": <ec_value> }, ...]. We scope the search to
    the transaction's EC page(s) (ec_page_start/end from ec_final.json) and
    anchor on the EC document number so we land on the RIGHT row — not every
    place a name happens to appear across the EC. max_occurrences=1 keeps each
    value boxed once. Result is cached per document under the run's output dir.
    """
    import asyncio
    import shutil
    import tempfile
    from api.validate.visual_debugger import VisualDebugger
    from common.gemini_helper import GeminiHelper
    from common.run_paths import RunPaths
    from common.storage import get_storage
    from services.artifact_store import read_json_artifact

    # Page-scope from the stored EC page range for THIS transaction, and grab the
    # EC's own document number as the primary row anchor. Empty page_info -> the
    # debugger scans all pages (older caches without page numbers).
    page_info = ""
    ec_doc_anchor = ""
    try:
        ec_data = read_json_artifact(request_id, "ec_final.json") if request_id else None
        if isinstance(ec_data, dict) and isinstance(ec_data.get("data"), list):
            ec_data = ec_data["data"]
        entries = _find_ec_entries_for_doc(ec_data, doc_no) if isinstance(ec_data, list) else []
        if entries:
            entry = entries[0]
            ps, pe = entry.get("ec_page_start"), entry.get("ec_page_end")
            if isinstance(ps, int) and isinstance(pe, int) and 1 <= ps <= pe:
                page_info = "Pages " + ", ".join(str(n) for n in range(ps, pe + 1))
            ec_doc_anchor = str(entry.get("document_number") or "").strip()
    except Exception as e:
        print(f"[!] mark-ec: could not read EC page scope for {doc_no}: {e}")

    _PLACEHOLDER = ("", "n/a", "na", "none", "null", "not found", "unknown", "missing")
    queued = []
    # Anchor on the EC's document number first (most reliable row locator), so
    # the page scan disambiguates which row to box when a name repeats.
    if ec_doc_anchor and ec_doc_anchor.lower() not in _PLACEHOLDER:
        queued.append({"field": "Document Number", "value": ec_doc_anchor, "page_info": page_info})
    for m in (mismatches or []):
        val = m.get("value")
        if val and str(val).strip().lower() not in _PLACEHOLDER:
            queued.append({"field": m.get("field", "") or "", "value": val, "page_info": page_info})
    if not queued:
        return {"url": None, "reason": "No EC-side values to mark for this document."}

    safe_doc = re.sub(r"[^a-zA-Z0-9]", "_", str(doc_no))
    marked_name = f"{safe_doc}_ec.pdf"

    rp = RunPaths(request_id, kind="validate").ensure()
    output_dir = rp.output_dir
    marked_path = os.path.join(output_dir, "matched_docs", marked_name)
    rel_path = f"validate/{request_id}/matched_docs/{marked_name}"

    # Cached marked EC for this document.
    if os.path.exists(marked_path) or ensure_local(marked_path):
        return {"url": rel_path}

    # Locate the parcel's EC document.
    db = SessionLocal()
    try:
        from common.landwise_models import LandwiseDocument
        docs = (
            db.query(LandwiseDocument)
            .filter(LandwiseDocument.parcel_id == parcel_id, LandwiseDocument.deleted_at.is_(None))
            .all()
        )
    finally:
        db.close()
    ec_doc = next(
        (d for d in docs if d.document_type and d.document_type.upper().replace(" ", "_") in ("ENCUMBRANCE_CERTIFICATE", "EC")),
        None,
    )
    if not ec_doc:
        return {"url": None, "reason": "No EC document found for this parcel."}

    storage = get_storage()
    tmpdir = tempfile.mkdtemp(prefix="mark_ec_")
    try:
        # Name the local copy per-document so the marked output (matched_docs/
        # <basename>) is unique to this deed's mismatches.
        src = os.path.join(tmpdir, marked_name)
        materialized = False
        if ec_doc.storage_key and os.path.isabs(ec_doc.storage_key) and os.path.exists(ec_doc.storage_key):
            shutil.copy2(ec_doc.storage_key, src); materialized = True
        else:
            try:
                if ec_doc.storage_key and storage.exists(ec_doc.storage_key):
                    storage.download_to(ec_doc.storage_key, src); materialized = True
            except Exception as e:
                print(f"[!] mark-ec: EC download failed: {e}")
            if not materialized and ec_doc.file_content:
                with open(src, "wb") as f:
                    f.write(ec_doc.file_content)
                materialized = True
        if not materialized:
            return {"url": None, "reason": "Could not load the EC PDF."}

        gemini = GeminiHelper(model_id="gemini-3.5-flash")
        vd = VisualDebugger(gemini, output_dir=output_dir)
        # Drain the generator off the event loop (it rasterizes + calls Gemini).
        await asyncio.to_thread(
            lambda: list(vd.debug_mismatches_batch(
                pdf_path=src, doc_no=f"EC_{doc_no}", mismatches=queued, max_occurrences=1,
            ))
        )

        if not os.path.exists(marked_path):
            return {"url": None, "reason": "Could not locate any of the values on the EC."}

        try:
            sync_dir(
                os.path.join(output_dir, "matched_docs"),
                key_prefix=f"outputs/validate/{request_id}/matched_docs",
            )
        except Exception as e:
            print(f"[!] mark-ec sync failed: {e}")
        return {"url": rel_path}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def handle_validate_single(request: Request, body: dict):
    """
    Performs validation for a single document.
    Expects body with: request_id, doc_no
    file_path is optional (used as a hint); the server resolves the true path.
    """
    request_id = body.get("request_id")
    doc_no = body.get("doc_no")
    file_path_hint = body.get("file_path", "")  # optional hint from frontend

    print(f"[*] handle_validate_single: doc_no={doc_no}, request_id={request_id}, hint={file_path_hint}")
    if not all([request_id, doc_no]):
        print(f"[!] Missing fields: request_id={request_id}, doc_no={doc_no}")
        raise HTTPException(status_code=400, detail="Missing required fields: request_id, doc_no")

    # Absolute paths
    processing_output_dir = os.path.join("outputs", "validate", request_id)
    ec_json_path = os.path.join(processing_output_dir, "ec_final.json")

    # --- Authoritative server-side PDF path resolution ---
    abs_pdf_path = resolve_pdf_path(doc_no, request_id=request_id, hint=file_path_hint)


    if not abs_pdf_path:
        print(f"[!] PDF not found for {doc_no} (ID: {request_id}). Checked multiple paths.")
        raise HTTPException(
            status_code=404,
            detail=f"PDF not found for document '{doc_no}' in request {request_id}. Ensure validation has been completed."
        )

    print(f"[*] Resolved PDF path: {abs_pdf_path}")
    print(f"[*] Checking for EC path: {ec_json_path}")

    if not os.path.exists(ec_json_path):
        print(f"[!] EC file missing: {ec_json_path}")
        raise HTTPException(status_code=404, detail=f"EC records not found for request {request_id}")


    try:
        # 1. Ensure metadata exists
        print(f"[*] Ensuring metadata for {abs_pdf_path}")
        sd_proc = SaleDeedProcessor(output_dir=processing_output_dir)
        sd_proc.process_file(abs_pdf_path)

        # 2. Run validation
        print(f"[*] Running validator for {doc_no}")
        validator = Validator(output_dir=processing_output_dir)
        # We need a doc dict as expected by validator
        doc_item = {
            "document_number": doc_no,
            "file_path": abs_pdf_path
        }
        
        result = validator.validate_single_doc(doc_item, ec_json_path, visual_debug=True)
        return result
    except Exception as e:
        print(f"[!] handle_validate_single failed: {str(e)}")
        raise e

def get_doc_map(request_id: str) -> dict:
    """Build a doc_no → frontend-relative-path map by listing S3.

    Returns paths like "validate/<rid>/matched_docs/<file>.pdf" or
    "storage/vault/<file>.pdf" that the frontend prepends with /files/ to
    get a presigned URL.
    """
    storage = get_storage()
    doc_map: dict = {}

    def _record(key: str):
        if not key.lower().endswith(".pdf"):
            return
        base = os.path.splitext(os.path.basename(key))[0]
        d_no_derived = base.replace("_", "/")
        # The frontend builds /files/<rel> → S3 key outputs/<rel>.
        rel = key[len("outputs/"):] if key.startswith("outputs/") else key
        doc_map.setdefault(d_no_derived, rel)
        doc_map.setdefault(base, rel)

    # 1. Per-request outputs (validate/<rid>/matched_docs, pdf_vault, root).
    for key in storage.list_prefix(f"outputs/validate/{request_id}/"):
        _record(key)

    # 2. Per-request inputs (uploaded EC / deed PDFs).
    for key in storage.list_prefix(f"inputs/validate/{request_id}/"):
        # For inputs the canonical mount is /input-files/<rel> where
        # rel is the key minus the "inputs/" prefix. We still surface
        # the file as a usable path the frontend can resolve.
        if not key.lower().endswith(".pdf"):
            continue
        base = os.path.splitext(os.path.basename(key))[0]
        d_no_derived = base.replace("_", "/")
        rel = "../input-files/" + key[len("inputs/"):] if key.startswith("inputs/") else key
        doc_map.setdefault(d_no_derived, rel)
        doc_map.setdefault(base, rel)

    # 3. Global vault.
    for key in storage.list_prefix("outputs/storage/vault/"):
        _record(key)

    # 4. Overlay anything that results.json says — its file_path may already
    #    be the correct frontend-relative path (validate/<rid>/matched_docs/...).
    results = read_json(f"outputs/validate/{request_id}/results.json", default=None) or []
    for res in results:
        d_no = res.get("document_number")
        f_path = res.get("file_path") or res.get("vault_path")
        if d_no and f_path:
            f_path = f_path.replace("\\", "/")
            if f_path.startswith("outputs/"):
                f_path = f_path[len("outputs/"):]
            doc_map[d_no] = f_path

    return doc_map

async def handle_get_global_hierarchy(request_id: str):
    # Cache hit short-circuit: hierarchy responses are immutable per
    # request_id, so once we've assembled one we can return it directly.
    cached = _HIERARCHY_CACHE.get(request_id)
    if cached is not None:
        return cached

    # Three-tier read through the canonical helper (Phase 3 / item #37).
    # Local-scratch first (fast path during an active analyze), then S3,
    # then the DB AnalysisResult row as a last-ditch fallback. The DB
    # fallback closure isolates the model knowledge from artifact_store.
    from services.artifact_store import read_json_artifact

    def _hierarchy_from_db():
        from common.database import SessionLocal
        from common.landwise_models import AnalysisResult
        db = SessionLocal()
        try:
            row = db.query(AnalysisResult).filter(
                AnalysisResult.request_id == request_id,
                AnalysisResult.result_type == 'hierarchy_tree',
            ).first()
            return row.data if row else None
        finally:
            db.close()

    hierarchy_data = read_json_artifact(
        request_id, "hierarchy_tree.json", db_fallback=_hierarchy_from_db,
    )

    if not hierarchy_data:
        raise HTTPException(status_code=404, detail="Hierarchy data not available")

    doc_map = get_doc_map(request_id)
    gen = HierarchyGenerator(output_dir="")
    gen.node_counter = 0
    rf_data = gen._generate_react_flow_data(hierarchy_data, doc_map=doc_map)

    # 3. Load validation results — local → S3 → DB ValidationResult fallback.
    # The DB fallback is new (audit item #10): previously this only checked
    # results.json then final_result.json on S3, so a parcel whose validation
    # was persisted ONLY to DB (rare; happens when analyze crashed between
    # the DB commit and the sync_dir) showed 0 validation results in the
    # hierarchy view.
    def _validation_from_db():
        from common.database import SessionLocal
        try:
            from common.models import ValidationResult
        except ImportError:
            return None
        db = SessionLocal()
        try:
            rows = db.query(ValidationResult).filter(
                ValidationResult.request_id == request_id,
            ).all()
            if not rows:
                return None
            return [
                {
                    "document_number": r.document_number,
                    "match": r.match,
                    "reason_for_failure": r.reason_for_failure,
                    "file_path": r.file_path,
                    "vault_path": r.vault_path,
                    "validation_result": {
                        "trustability_score": r.trustability_score,
                        "comparisons": r.comparisons,
                    },
                }
                for r in rows
            ]
        finally:
            db.close()

    validation_results = read_json_artifact(
        request_id, "results.json", db_fallback=None,
    )
    if not validation_results:
        final_data = read_json_artifact(request_id, "final_result.json")
        if isinstance(final_data, dict):
            validation_results = final_data.get("results", []) or []
    if not validation_results:
        validation_results = _validation_from_db() or []

    # Normalize file_path on every result so legacy / leaking paths like
    # tmp/work/validate/<rid>/matched_docs/x.pdf become the frontend-relative
    # validate/<rid>/matched_docs/x.pdf that /files/{key} can resolve.
    def _normalize_file_path(p: str) -> str:
        if not isinstance(p, str):
            return p
        s = p.replace("\\", "/").lstrip("./")
        if s.startswith("tmp/work/"):
            s = s[len("tmp/work/"):]
        elif s.startswith("outputs/"):
            s = s[len("outputs/"):]
        return s

    for res in validation_results:
        if isinstance(res, dict):
            if "file_path" in res:
                res["file_path"] = _normalize_file_path(res.get("file_path"))
            if "vault_path" in res:
                res["vault_path"] = _normalize_file_path(res.get("vault_path"))

    # 4. Load EC final data for Ownership Tabs.
    # The earlier refactor that introduced read_json_artifact removed the
    # local `s3_prefix` variable but missed this trailing call site —
    # producing the "NameError: name 's3_prefix' is not defined" that
    # 500'd /hierarchy. Routing it through the same artifact_store helper
    # keeps the three-tier (local → S3 → DB) discipline consistent.
    ec_final = read_json_artifact(request_id, "ec_final.json") or []

    payload = {
        "status": "success",
        "react_flow_data": rf_data,
        "validation_results": validation_results,
        "ec_final": ec_final,
        "request_id": request_id
    }
    _HIERARCHY_CACHE.set(request_id, payload)
    return payload

async def handle_search_survey_timeline(request_id: str, survey_number: str, limit: Optional[int] = None):
    hierarchy_path = os.path.join("outputs", "validate", request_id, "hierarchy_tree.json")
    hierarchy_data = None
    
    if os.path.exists(hierarchy_path):
        with open(hierarchy_path, 'r', encoding='utf-8') as f:
            hierarchy_data = json.load(f)
    else:
        # Fallback to Database
        from common.database import SessionLocal
        from common.landwise_models import AnalysisResult
        db = SessionLocal()
        try:
            result = db.query(AnalysisResult).filter(
                AnalysisResult.request_id == request_id,
                AnalysisResult.result_type == 'hierarchy_tree'
            ).first()
            if result:
                hierarchy_data = result.data
        finally:
            db.close()
            
    if not hierarchy_data:
        raise HTTPException(status_code=404, detail="Hierarchy timeline data is not available.")
    
    doc_map = get_doc_map(request_id)
    source_dir = os.path.join("inputs", "validate", request_id, "sale_deeds")
    if not os.path.exists(source_dir):
        source_dir = os.path.join("inputs", "validate", request_id)
    
    gen = HierarchyGenerator(output_dir="")
    timeline = gen.find_survey_timeline(hierarchy_data, survey_number, limit=limit, doc_map=doc_map, source_docs_dir=source_dir)
    
    return {"status": "success", "timeline": timeline}


async def handle_generate_report(request_id: str):
    """
    Generates a formal Legal Opinion Report based on validated hierarchy data.

    Data source is dual: local scratch first (fast path during an active
    analyze run), then the S3-mirrored canonical copy. The previous
    implementation only checked local disk, so any /report call after a
    backend restart — or against a request_id whose scratch dir had been
    cleaned up — 404'd even though the data was fine on S3. Same
    architectural bug we already fixed for /hierarchy and /report-sections.
    """
    from common.gemini_helper import GeminiHelper
    from prompts.opinion_prompts import OPINION_REPORT_PROMPT
    from common.storage_sync import read_json as _storage_read_json, ensure_local as _storage_ensure_local

    # 1. Load Data — local-first, S3 fallback
    target_dir = os.path.join("outputs", "validate", request_id)
    hierarchy_path = os.path.join(target_dir, "hierarchy_tree.json")
    results_path = os.path.join(target_dir, "results.json")
    # Same paths are valid S3 keys (forward-slash-normalized).
    hierarchy_key = f"outputs/validate/{request_id}/hierarchy_tree.json"
    results_key = f"outputs/validate/{request_id}/results.json"

    hierarchy_data = None
    if os.path.exists(hierarchy_path):
        with open(hierarchy_path, 'r', encoding='utf-8') as f:
            hierarchy_data = json.load(f)
    else:
        # S3 fallback: pull the hierarchy down. read_json returns None ONLY
        # when the key truly doesn't exist; transient S3 errors raise
        # (handled by the storage_sync retry layer) so we won't 404 on a
        # network blip.
        hierarchy_data = _storage_read_json(hierarchy_key, default=None)
        if hierarchy_data is None:
            # Last-ditch: maybe the analyze persisted it to DB instead.
            from common.database import SessionLocal as _SL
            from common.landwise_models import AnalysisResult as _AR
            db = _SL()
            try:
                result = db.query(_AR).filter(
                    _AR.request_id == request_id,
                    _AR.result_type == 'hierarchy_tree'
                ).first()
                if result:
                    hierarchy_data = result.data
            finally:
                db.close()

    if not hierarchy_data:
        print(f"[!] Hierarchy missing for report: {hierarchy_path} (also not in S3 / DB)")
        raise HTTPException(status_code=404, detail="Hierarchy data not available. Please complete validation first.")

    # validation_results.json — same local-first, S3-fallback pattern.
    validation_results = []
    if os.path.exists(results_path):
        with open(results_path, 'r', encoding='utf-8') as f:
            validation_results = json.load(f)
    else:
        validation_results = _storage_read_json(results_key, default=None) or []
        # Final fallback: final_result.json wraps results in {"results": [...]}
        if not validation_results:
            final_key = f"outputs/validate/{request_id}/final_result.json"
            final_data = _storage_read_json(final_key, default=None)
            if isinstance(final_data, dict):
                validation_results = final_data.get("results", []) or []

    # 2. Format Data for LLM
    # We flatten the hierarchy a bit to make it readable in the prompt
    flattened_history = []
    def traverse(nodes):
        for n in nodes:
            sn = n.get('survey_number', 'Unknown')
            for tx in n.get('transactions', []):
                flattened_history.append({
                    "Date": tx.get('date'),
                    "Doc_No": tx.get('document_number'),
                    "Nature": tx.get('nature'),
                    "Parties": f"{tx.get('executant')} -> {tx.get('claimant')}",
                    "Survey_No": sn
                })
            children = n.get('children', {})
            traverse(children.values() if isinstance(children, dict) else children)

    traverse(hierarchy_data)
    
    # 2.5 Enrich history with full metadata from extraction files
    # Same dual-tier discipline: local first, then storage fallback. The
    # second fallback (matched_docs subfolder) is preserved, with its own
    # storage probe so a backend that lost local scratch but has the S3
    # mirror still enriches the report instead of falling back to a
    # contentless prompt.
    for entry in flattened_history:
        doc_no = entry.get("Doc_No", "").replace('/', '_')
        metadata_filename = f"{doc_no}_metadata.txt"
        candidate_local_paths = [
            os.path.join(target_dir, metadata_filename),
            os.path.join(target_dir, "matched_docs", metadata_filename),
        ]
        candidate_keys = [
            f"outputs/validate/{request_id}/{metadata_filename}",
            f"outputs/validate/{request_id}/matched_docs/{metadata_filename}",
        ]

        chosen = next((p for p in candidate_local_paths if os.path.exists(p)), None)
        if not chosen:
            # Try to materialize from S3 into local scratch. ensure_local()
            # is a no-op if the file already exists; on miss it pulls the
            # bytes down and creates the dir tree. Stops on first success.
            for local_p, key in zip(candidate_local_paths, candidate_keys):
                if _storage_ensure_local(local_p, key=key):
                    chosen = local_p
                    break

        if chosen and os.path.exists(chosen):
            try:
                with open(chosen, 'r', encoding='utf-8') as f:
                    entry["Full_Metadata"] = f.read()
            except Exception as _e:
                # Per-doc enrichment is best-effort; one bad file shouldn't
                # tank the whole report. Log and move on.
                print(f"[!] Could not read metadata for {doc_no}: {_e}")

    # Sort history by date
    from api.validate.hierarchy_generator import HierarchyGenerator
    hg = HierarchyGenerator(output_dir="")
    flattened_history.sort(key=lambda x: hg._parse_date_for_sort(x['Date']))

    # Extract Red Flags and Scrutiny Alert documents from validation results
    red_flags = [
        r for r in validation_results 
        if not r.get('match') or r.get('validation_result', {}).get('requires_extra_scrutiny')
    ]

    # 3. Generate Report via LLM
    gemini = GeminiHelper(model_id="gemini-3.5-flash") # Use standard flash for drafting
    
    prompt = OPINION_REPORT_PROMPT.format(
        hierarchy=json.dumps(flattened_history, indent=2),
        validation_results=json.dumps(validation_results[-10:], indent=2), # Last 10 matches for context
        red_flags=json.dumps(red_flags, indent=2)
    )

    try:
        print(f"[*] Generating Legal Opinion Report for {request_id}...")
        report_content = gemini.generate_from_text("", prompt)
        # Decode literal \uXXXX sequences (LLM occasionally emits Tamil as escapes)
        report_content = _decode_unicode_escapes(report_content)

        # New requested path structure: outputs/{request_id}/legal/report.md
        legal_dir = os.path.join(target_dir, "legal")
        os.makedirs(legal_dir, exist_ok=True)

        # 1. Save Markdown version
        report_filename_md = "legal_opinion_report.md"
        report_path_md = os.path.join(legal_dir, report_filename_md)
        with open(report_path_md, 'w', encoding='utf-8') as f:
            f.write(report_content)

        # 2. Save PDF version using fpdf2
        from fpdf import FPDF

        # Parse first so we can render the PDF from the structured tree
        parsed_sections = parse_report_sections(report_content)

        # Page geometry constants
        PAGE_W = 210                 # A4 width (mm)
        L_MARGIN = 18
        R_MARGIN = 18
        T_MARGIN = 18
        B_MARGIN = 18
        USABLE_W = PAGE_W - L_MARGIN - R_MARGIN  # 174mm

        # Strip characters helvetica can't render (Tamil etc.) → "[…]" placeholder kept compact
        def latin1_safe(text: str) -> str:
            if text is None:
                return ""
            try:
                return text.encode('latin-1', 'replace').decode('latin-1').replace('�', '?')
            except Exception:
                return text.encode('ascii', 'ignore').decode('ascii')

        class PDFReport(FPDF):
            def header(self):
                # Top accent bar
                self.set_fill_color(30, 58, 138)  # Indigo
                self.rect(0, 0, PAGE_W, 6, style='F')
                self.set_y(10)
                self.set_font('helvetica', 'B', 15)
                self.set_text_color(15, 23, 42)
                self.cell(0, 8, 'LEGAL VERIFICATION OF TITLE REPORT', border=False, align='C', new_x="LMARGIN", new_y="NEXT")
                self.set_font('helvetica', 'I', 9)
                self.set_text_color(100, 116, 139)
                self.cell(0, 5, 'State of Tamil Nadu  -  LandwiseAI Legal Advisor', border=False, align='C', new_x="LMARGIN", new_y="NEXT")
                self.ln(2)
                # Divider
                self.set_draw_color(226, 232, 240)
                self.set_line_width(0.3)
                self.line(L_MARGIN, self.get_y(), PAGE_W - R_MARGIN, self.get_y())
                self.ln(4)

            def footer(self):
                self.set_y(-12)
                self.set_font('helvetica', 'I', 8)
                self.set_text_color(148, 163, 184)
                self.cell(0, 5, f'Page {self.page_no()} / {{nb}}', align='C')

        pdf = PDFReport()
        pdf.alias_nb_pages()
        pdf.set_auto_page_break(auto=True, margin=B_MARGIN)
        pdf.set_margins(L_MARGIN, T_MARGIN, R_MARGIN)
        pdf.add_page()

        # ── Cover/preamble: render any preamble text before the first numbered section
        preamble_lines = []
        for raw in report_content.split('\n'):
            stripped = raw.strip()
            if re.match(r'^#{0,4}\s*\d+\)\s+', stripped) or re.match(r'^#{0,4}\s*(?:\*\*)?\s*FINAL\s+VERDICT', stripped, re.IGNORECASE):
                break
            preamble_lines.append(raw)

        if preamble_lines:
            pdf.set_font('helvetica', '', 10)
            pdf.set_text_color(51, 65, 85)
            for line in preamble_lines:
                clean = latin1_safe(
                    line.replace('**', '').replace('###', '').replace('---', '-' * 60)
                ).rstrip()
                if not clean.strip():
                    pdf.ln(2)
                    continue
                pdf.set_x(L_MARGIN)
                pdf.multi_cell(USABLE_W, 5.2, clean)
            pdf.ln(2)
            pdf.set_draw_color(226, 232, 240)
            pdf.line(L_MARGIN, pdf.get_y(), PAGE_W - R_MARGIN, pdf.get_y())
            pdf.ln(4)

        # Latin-1 has no bullet glyph — use a hyphen (helvetica-safe).
        BULLET_CHAR = '-'

        def render_paragraph(text: str, bullet: bool = False, indent: float = 0.0):
            """Render a wrapped paragraph at the current y, optionally with a bullet."""
            if not text:
                return
            if bullet:
                pdf.set_x(L_MARGIN + indent)
                pdf.set_font('helvetica', '', 10)
                pdf.cell(4, 5.2, BULLET_CHAR)
                pdf.set_x(L_MARGIN + indent + 4)
                pdf.multi_cell(USABLE_W - indent - 4, 5.2, latin1_safe(text))
            else:
                pdf.set_x(L_MARGIN + indent)
                pdf.multi_cell(USABLE_W - indent, 5.2, latin1_safe(text))

        # ── Render structured sections
        for sec in parsed_sections:
            is_final = str(sec.get('number')) == 'F'

            # Section header
            pdf.ln(2)
            pdf.set_font('helvetica', 'B', 12)
            if is_final:
                pdf.set_text_color(190, 18, 60)   # Rose-700
            else:
                pdf.set_text_color(30, 58, 138)   # Indigo-900
            heading_label = (
                'FINAL VERDICT & LEGAL OPINION'
                if is_final else
                f"{sec['number']})  {sec['title']}"
            )
            pdf.set_x(L_MARGIN)
            pdf.multi_cell(USABLE_W, 6.5, latin1_safe(heading_label))

            # Coloured underline accent
            y = pdf.get_y()
            if is_final:
                pdf.set_draw_color(244, 63, 94)
            else:
                pdf.set_draw_color(99, 102, 241)
            pdf.set_line_width(0.5)
            pdf.line(L_MARGIN, y + 0.6, L_MARGIN + 32, y + 0.6)
            pdf.ln(3)

            # Subtitles
            for sub in sec.get('subtitles', []):
                pdf.set_font('helvetica', 'B', 10)
                pdf.set_text_color(15, 23, 42)
                pdf.set_x(L_MARGIN)
                pdf.multi_cell(USABLE_W, 5.5, latin1_safe(f"{sub['letter']}.  {sub['title']}"))

                if sub.get('content'):
                    pdf.set_font('helvetica', '', 10)
                    pdf.set_text_color(51, 65, 85)
                    # Each subtitle's content may have multiple paragraphs/bullets
                    for raw in sub['content'].split('\n'):
                        line = raw.rstrip()
                        if not line.strip():
                            pdf.ln(1.5)
                            continue
                        # Strip leading bullet markers/asterisks the LLM emits
                        m_b = re.match(r'^\s*\*\s+(.*)$', line)
                        cleaned = (m_b.group(1) if m_b else line).strip()
                        cleaned = cleaned.replace('**', '')
                        if m_b:
                            render_paragraph(cleaned, bullet=True, indent=4)
                        else:
                            render_paragraph(cleaned, indent=4)
                pdf.ln(1.5)

            # If section has a flat content body (e.g. section 8 / FINAL VERDICT)
            body = sec.get('content') or ''
            if body:
                pdf.set_font('helvetica', '', 10)
                pdf.set_text_color(51, 65, 85)
                for raw in body.split('\n'):
                    line = raw.rstrip()
                    if not line.strip():
                        pdf.ln(1.5)
                        continue
                    # Identify nested bullet by leading whitespace
                    leading = len(line) - len(line.lstrip(' \t'))
                    indent = 4 + (4 if leading >= 4 else 0)
                    m_b = re.match(r'^\s*\*\s+(.*)$', line)
                    if m_b:
                        cleaned = m_b.group(1).strip().replace('**', '')
                        render_paragraph(cleaned, bullet=True, indent=indent)
                    else:
                        # Numbered paragraph (1. **Title**) → bold lead
                        m_n = re.match(r'^(\d+)\.\s+\*\*(.+?)\*\*[:\.]?\s*(.*)$', line.strip())
                        if m_n:
                            pdf.set_x(L_MARGIN)
                            pdf.set_font('helvetica', 'B', 10)
                            pdf.set_text_color(15, 23, 42)
                            pdf.multi_cell(USABLE_W, 5.5, latin1_safe(f"{m_n.group(1)}. {m_n.group(2)}"))
                            tail = m_n.group(3).strip().replace('**', '')
                            if tail:
                                pdf.set_font('helvetica', '', 10)
                                pdf.set_text_color(51, 65, 85)
                                render_paragraph(tail, indent=4)
                        else:
                            cleaned = line.strip().replace('**', '')
                            render_paragraph(cleaned, indent=4)

            pdf.ln(2)
            # Soft separator between sections (not after the last)
            if sec is not parsed_sections[-1]:
                pdf.set_draw_color(241, 245, 249)
                pdf.set_line_width(0.2)
                pdf.line(L_MARGIN, pdf.get_y(), PAGE_W - R_MARGIN, pdf.get_y())
                pdf.ln(2)

        report_filename_pdf = "legal_opinion_report.pdf"
        report_path_pdf = os.path.join(legal_dir, report_filename_pdf)
        pdf.output(report_path_pdf)

        # Mirror the freshly-written legal/ folder to storage so the
        # subsequent /download-by-path can stream the PDF (and the
        # /report-sections endpoint can re-read the .md after a restart).
        # Without this sync the legal artifacts stayed local-only:
        # `outputs/validate/<rid>/legal/legal_opinion_report.pdf` would
        # be returned in `report_url` but the next GET against
        # /download-by-path 404'd because the key was never created on S3.
        # We use the existing storage_sync helpers — they're no-ops when
        # STORAGE_BACKEND=local, so the local-dev flow is unaffected.
        s3_prefix = f"outputs/validate/{request_id}/legal"
        try:
            sync_file(report_path_md,
                      content_type="text/markdown; charset=utf-8",
                      key=f"{s3_prefix}/{report_filename_md}")
            sync_file(report_path_pdf,
                      content_type="application/pdf",
                      key=f"{s3_prefix}/{report_filename_pdf}")
            print(f"[+] Synced legal report artifacts to {s3_prefix}/")
        except Exception as _e:
            # Non-fatal: the local copy still works for an in-process
            # response; the user can re-trigger generation if S3 is down.
            print(f"[!] Failed to sync legal report to storage (non-fatal): {_e}")

        return {
            "status": "success",
            "report_md": report_content,
            "report_url": f"outputs/validate/{request_id}/legal/{report_filename_pdf}",
            "sections": parsed_sections
        }
    except Exception as e:
        print(f"[!] Report generation failure: {str(e)}")
        raise HTTPException(status_code=500, detail=f"AI drafting failed: {str(e)}")


def _decode_unicode_escapes(text: str) -> str:
    """The LLM sometimes emits JSON-style ``\\uXXXX`` escapes as literal text
    (backslash + u + four hex digits). Decode them in-place so the markdown
    contains real characters (e.g. Tamil) rather than escape sequences."""
    if not text or '\\u' not in text:
        return text
    try:
        return re.sub(
            r'\x5cu([0-9a-fA-F]{4})',
            lambda m: chr(int(m.group(1), 16)),
            text,
        )
    except Exception:
        return text


def parse_report_sections(report_content: str) -> list:
    """
    Parse the markdown report into structured sections with subtitles.

    Handles formats produced by the LLM:
      - Section headers:  `### 1) POSSESSION & REVENUE RECORDS` (with or without `###`)
      - Subtitle bullets: `*   **A. Title:** body text on same line...`
                          `**A. Title**` (legacy)
      - Continuation lines (body text wrapping under a subtitle)
      - Trailing FINAL VERDICT block (treated as its own section)

    Returns a list of dicts: { number, title, content, subtitles: [{ letter, title, content }] }
    """
    import re

    # Decode any literal \uXXXX escapes the LLM may have emitted (Tamil etc.)
    report_content = _decode_unicode_escapes(report_content)

    sections = []
    current_section = None
    current_subtitle = None
    buffer: list = []

    main_section_pattern   = re.compile(r'^\s*#{0,4}\s*(\d+)\)\s+(.+?)\s*$')
    final_verdict_pattern  = re.compile(r'^\s*#{0,4}\s*(?:\*\*)?\s*FINAL\s+VERDICT[^\n]*$', re.IGNORECASE)
    # Bullet form: `*   **A. Title:** body...` — captures letter, title, and inline body
    bullet_subtitle_pattern = re.compile(r'^\s*\*\s+\*\*([A-Z])\.\s*([^*:]+?):?\*\*\s*(.*)$')
    # Heading form: `**A. Title**` — captures letter and title only
    heading_subtitle_pattern = re.compile(r'^\s*\*\*([A-Z])\.\s*(.+?)\*\*\s*$')

    def flush_subtitle():
        nonlocal current_subtitle
        if current_subtitle is not None and current_section is not None:
            tail = '\n'.join(buffer).strip()
            if tail:
                current_subtitle['content'] = (
                    (current_subtitle['content'] + '\n' + tail) if current_subtitle['content'] else tail
                ).strip()
            current_section['subtitles'].append(current_subtitle)
            buffer.clear()
        current_subtitle = None

    def flush_section():
        nonlocal current_section
        if current_section is not None:
            if current_subtitle is not None:
                flush_subtitle()
            # If anything remains in buffer (pre-subtitle body or body of a section without subtitles)
            if buffer:
                current_section['content'] = '\n'.join(buffer).strip()
                buffer.clear()
            sections.append(current_section)
        current_section = None

    for raw in report_content.split('\n'):
        line = raw.rstrip()

        # Numbered section: `### 1) POSSESSION & REVENUE RECORDS`
        m = main_section_pattern.match(line)
        if m:
            flush_section()
            current_section = {
                'number': m.group(1),
                'title': m.group(2).strip(),
                'content': '',
                'subtitles': []
            }
            buffer.clear()
            continue

        # FINAL VERDICT block (treated as its own section)
        if final_verdict_pattern.match(line):
            flush_section()
            current_section = {
                'number': 'F',
                'title': 'FINAL VERDICT & LEGAL OPINION',
                'content': '',
                'subtitles': []
            }
            buffer.clear()
            continue

        # Bullet subtitle with inline body: `*   **A. Title:** body...`
        bm = bullet_subtitle_pattern.match(line)
        if bm and current_section is not None:
            flush_subtitle()
            current_subtitle = {
                'letter': bm.group(1),
                'title': bm.group(2).strip(),
                'content': bm.group(3).strip()
            }
            continue

        # Plain heading subtitle: `**A. Title**`
        hm = heading_subtitle_pattern.match(line)
        if hm and current_section is not None:
            flush_subtitle()
            current_subtitle = {
                'letter': hm.group(1),
                'title': hm.group(2).strip(),
                'content': ''
            }
            continue

        # Skip horizontal rules
        if line.strip() == '---':
            continue

        # Continuation / body text
        if line.strip():
            buffer.append(line)

    flush_section()

    return sections


def _normalize_party_name(name: str) -> str:
    """
    Normalize a party name for chain-of-title comparison.
    - Lowercase, collapse whitespace
    - Drop common honorifics, salutations, kinship prefixes
    - Strip punctuation and trailing relationship phrases
    Used ONLY for set-membership comparisons; the original string is preserved
    in the API response so the UI shows the registry-original spelling.
    """
    if not name:
        return ""
    s = str(name).strip().lower()
    # Strip kinship/relationship suffixes (..."s/o foo", "w/o bar", "rep. by ...")
    s = re.sub(r"\b(s/o|d/o|w/o|c/o|h/o|son of|daughter of|wife of|husband of|child of|represented by|rep\.? by|alias|@)\b.*$", "", s)
    # Drop honorifics
    s = re.sub(r"\b(mr|mrs|ms|miss|smt|sri|shri|thiru|tmt|selvi|dr|prof|m/s|messrs)\.?\s*", " ", s)
    # Drop everything in parentheses
    s = re.sub(r"\(.*?\)", " ", s)
    # Drop initials patterns like "S." -> "" so "S Ramesh" matches "Sumesh Ramesh" loosely
    # (We intentionally keep initials as letters; we don't expand them.)
    # Strip non-alphanumeric (keep spaces)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _parties_overlap(party_set_a: set, party_set_b: set) -> bool:
    """
    Returns True if any normalized name in A is contained in any normalized name in B
    (or vice versa). Handles "S Ramesh" vs "Ramesh Kumar" by token overlap of >=1
    significant token (length >= 3). Conservative — designed to avoid false negatives
    in chain continuity, where a missed match raises a (recoverable) flag rather than
    silently letting a broken chain through.
    """
    if not party_set_a or not party_set_b:
        return False
    norm_a = {_normalize_party_name(x) for x in party_set_a if x}
    norm_b = {_normalize_party_name(x) for x in party_set_b if x}
    norm_a.discard("")
    norm_b.discard("")
    if not norm_a or not norm_b:
        return False
    # Direct containment first
    for a in norm_a:
        for b in norm_b:
            if a == b or a in b or b in a:
                return True
    # Token overlap fallback (any significant shared token)
    def _tokens(s: str) -> set:
        return {t for t in s.split() if len(t) >= 3}
    tokens_a = set().union(*(_tokens(a) for a in norm_a))
    tokens_b = set().union(*(_tokens(b) for b in norm_b))
    # Drop overly generic tokens that would create false matches
    common_noise = {"the", "and", "ltd", "limited", "inc", "private", "pvt", "company"}
    tokens_a -= common_noise
    tokens_b -= common_noise
    return bool(tokens_a & tokens_b)


# Nature-of-document classification used by the audit. Aligned with standard
# Indian registry practice: only "transfer" deeds change the title-holder.
TRANSFER_NATURES = (
    "sale", "absolute sale", "settlement", "partition", "gift",
    "conveyance", "exchange", "release", "deed of release",
    "sale agreement cum sale", "sale agreement"
)
ENCUMBRANCE_NATURES = (
    "mortgage", "simple mortgage", "equitable mortgage", "deposit of title deeds",
    "lease", "lien", "attachment", "lis pendens", "charge", "hypothecation"
)
ENCUMBRANCE_RELEASE_NATURES = (
    "mortgage release", "release of mortgage", "discharge", "satisfaction",
    "memo of satisfaction", "cancellation of mortgage",
    # TN registries record mortgage discharges as plain "Receipt" with a
    # PR Number pointing back to the parent mortgage (e.g., entry 1911/2009
    # discharging 2850/2004 in the Survey 63 EC). Without these terms, the
    # release-matching pass treated every Receipt as "other" → every
    # historical mortgage stayed open forever → the Encumbrances card
    # showed "10 ACTIVE" for a parcel that genuinely had 0 unreleased
    # mortgages.
    "receipt", "deed of receipt", "redemption", "deed of redemption",
)
PARTITION_NATURES = ("partition", "deed of partition")


def _classify_nature(nature: str) -> str:
    """Returns one of: 'transfer', 'encumbrance', 'encumbrance_release', 'other'."""
    n = (nature or "").lower().strip()
    if not n:
        return "other"
    if any(term in n for term in ENCUMBRANCE_RELEASE_NATURES):
        return "encumbrance_release"
    if any(term in n for term in ENCUMBRANCE_NATURES):
        # Mortgage release sometimes contains the word 'mortgage'; bias above.
        if any(term in n for term in ENCUMBRANCE_RELEASE_NATURES):
            return "encumbrance_release"
        return "encumbrance"
    if any(term in n for term in TRANSFER_NATURES):
        return "transfer"
    return "other"


def count_open_encumbrances_from_ec(ec_data: list) -> int:
    """
    Count UNRELEASED encumbrances in an EC by walking entries chronologically
    and matching each "mortgage discharge" / "deed of receipt" entry against
    the most recent unmatched mortgage / charge for the same parties.

    Why this exists:
        The `Encumbrance` DB rows written during analyze insert every
        mortgage/charge/attachment with `status='active'` and NEVER get
        updated when the EC contains the discharge receipts. So a parcel
        with 30 years of historical mortgages (all long discharged) was
        showing "10 ACTIVE encumbrances" forever on the Overview card.

        This helper mirrors the release-matching logic in
        handle_get_survey_ownership (lines 2929-2951) but in a cheap,
        no-DB form so the /stats endpoint can compute the right number
        on every dashboard load — no re-analyze required.

    Algorithm (matches the audit logic):
        1. Sort EC entries by execution date.
        2. For each entry, classify via _classify_nature.
        3. encumbrance      → push onto open list (creditor=buyer, borrower=seller).
        4. encumbrance_release → mark the most recent matching open entry as
                                  released (party-overlap on creditor or
                                  borrower); fall back to oldest open if no
                                  match (best-effort, same as the audit).
        5. Return count of entries still unreleased at the end.

    Args:
        ec_data: list of EC entry dicts as written to ec_final.json.

    Returns:
        Integer count of currently-unreleased encumbrances. 0 if the EC
        has no encumbrance entries OR every one of them has a matching
        release receipt later in the chain.
    """
    if not ec_data:
        return 0

    from api.validate.hierarchy_generator import HierarchyGenerator
    hg = HierarchyGenerator(output_dir="")

    # Normalize each entry into the same shape the audit consumes.
    def _split_parties(raw) -> set:
        if not raw:
            return set()
        if isinstance(raw, list):
            return {str(x).strip().lower() for x in raw if x}
        # String form — comma-split conservatively.
        return {p.strip().lower() for p in str(raw).split(",") if p.strip()}

    history = []
    for entry in ec_data:
        history.append({
            "date": entry.get("date") or "",
            "doc_no": entry.get("document_number") or "",
            "nature": entry.get("nature_of_document") or entry.get("nature") or "",
            "sellers_set": _split_parties(entry.get("sellers")),
            "buyers_set": _split_parties(entry.get("buyers")),
        })

    # Chronological sort, oldest → newest, so release receipts always
    # come AFTER the mortgage they discharge.
    history.sort(key=lambda x: hg._parse_date_for_sort(x["date"]))

    open_list: list[dict] = []
    for h in history:
        kind = _classify_nature(h["nature"])
        if kind == "encumbrance":
            # In TN mortgages: the "buyer" column = the mortgagee (creditor),
            # the "seller" column = the mortgagor (borrower). Surface both
            # so the release-match can hit either side.
            open_list.append({
                "creditor": h["buyers_set"],
                "borrower": h["sellers_set"],
                "released": False,
            })
        elif kind == "encumbrance_release":
            parties = h["sellers_set"] | h["buyers_set"]
            # Walk newest first so we discharge the MOST RECENT matching
            # open entry — matches the audit's reverse() walk.
            matched = False
            for enc in reversed(open_list):
                if enc["released"]:
                    continue
                if _parties_overlap(enc["creditor"], parties) or _parties_overlap(enc["borrower"], parties):
                    enc["released"] = True
                    matched = True
                    break
            if not matched:
                # Best-effort fallback: discharge the OLDEST open entry,
                # same conservative choice the audit makes.
                for enc in open_list:
                    if not enc["released"]:
                        enc["released"] = True
                        break

    return sum(1 for enc in open_list if not enc["released"])


async def handle_get_survey_ownership(request_id: str):
    """
    Analyzes EC data to provide a chain-of-title audit per survey number.

    Logic improvements over a naive 'latest buyer wins' approach:
      1. Mortgages and other encumbrances NEVER become the current owner — they
         attach a charge but leave title with the mortgagor.
      2. Chain continuity is checked: the seller(s) of transfer deed N+1 must
         overlap with the buyer(s) of some prior transfer deed (or be the
         original recorded owner). Breaks are flagged.
      3. Partition deeds split a single owner's holding among co-owners and are
         marked separately so they aren't treated as a clean buyer→buyer transfer.
      4. Open (un-released) mortgages/encumbrances are reported.
    """
    # Read from S3 (canonical) — falls back to local scratch if the file is
    # still mid-sync.
    ec_key = f"outputs/validate/{request_id}/ec_final.json"
    ec_data = read_json(ec_key, default=None)
    if ec_data is None:
        local_path = os.path.join("tmp", "work", "validate", request_id, "ec_final.json")
        if os.path.exists(local_path):
            with open(local_path, "r", encoding="utf-8") as f:
                ec_data = json.load(f)
    if not ec_data:
        raise HTTPException(status_code=404, detail="EC data not found for ownership analysis.")

    # Grouping logic
    ownership_map = {}

    for tx in ec_data:
        sn = tx.get("survey_number", "Unknown")
        if sn not in ownership_map:
            ownership_map[sn] = {
                "survey_number": sn,
                "transactions_count": 0,
                "all_sellers": set(),
                "all_buyers": set(),
                "history": []
            }

        entry = ownership_map[sn]
        entry["transactions_count"] += 1

        # Add sellers and buyers
        sellers = tx.get("sellers", [])
        buyers = tx.get("buyers", [])

        if isinstance(sellers, list):
            for s in sellers: entry["all_sellers"].add(s)
        if isinstance(buyers, list):
            for b in buyers: entry["all_buyers"].add(b)

        # Keep raw lists too so chain-continuity can compare party-sets
        # (joining into a single string loses multi-party joint ownership info).
        sellers_list = sellers if isinstance(sellers, list) else ([str(sellers)] if sellers else [])
        buyers_list = buyers if isinstance(buyers, list) else ([str(buyers)] if buyers else [])
        entry["history"].append({
            "date": tx.get("date", ""),
            "doc_no": tx.get("document_number", ""),
            "nature": tx.get("nature_of_document", ""),
            "seller": ", ".join(sellers_list) if sellers_list else "N/A",
            "buyer": ", ".join(buyers_list) if buyers_list else "N/A",
            "sellers_list": sellers_list,
            "buyers_list": buyers_list,
            "involved_surveys": tx.get("involved_surveys", [])
        })

    # Convert sets to sorted lists for JSON serialization
    results = []
    from api.validate.hierarchy_generator import HierarchyGenerator
    hg = HierarchyGenerator(output_dir="")

    for sn, data in ownership_map.items():
        # Sort history by date ascending (oldest to newest) for lineage display
        sorted_history = sorted(data["history"], key=lambda x: hg._parse_date_for_sort(x['date']))

        # Annotate each transaction with its classification + flags so the UI can render them.
        chain_breaks = []
        open_encumbrances = []
        partition_events = []
        prior_buyers_pool: set = set()  # cumulative pool of all known title-holders for this survey

        for idx, h in enumerate(sorted_history):
            kind = _classify_nature(h["nature"])
            h["kind"] = kind  # 'transfer' | 'encumbrance' | 'encumbrance_release' | 'other'
            h["is_current_owner_source"] = False  # will set later
            h["chain_break"] = False
            h["chain_note"] = None

            sellers_set = set(h.get("sellers_list") or [])
            buyers_set = set(h.get("buyers_list") or [])

            if kind == "transfer":
                # Chain continuity check — only after the first transfer deed.
                if prior_buyers_pool and sellers_set:
                    if not _parties_overlap(sellers_set, prior_buyers_pool):
                        h["chain_break"] = True
                        h["chain_note"] = (
                            "Seller does not appear as a buyer in any prior transfer deed "
                            "for this survey — possible missing intermediate document, "
                            "name discrepancy, or unrecorded transfer."
                        )
                        chain_breaks.append({
                            "doc_no": h["doc_no"],
                            "date": h["date"],
                            "nature": h["nature"],
                            "seller": h["seller"],
                            "expected_from": sorted(prior_buyers_pool)[:5],
                            "reason": h["chain_note"],
                        })

                # Partition deeds split title — flag separately, but their buyers
                # do count for the next chain hop.
                if any(term in h["nature"].lower() for term in PARTITION_NATURES):
                    partition_events.append({
                        "doc_no": h["doc_no"],
                        "date": h["date"],
                        "co_owners": h.get("buyers_list", []),
                    })

                # Add buyers to the prior-buyers pool (they are now the title-holders).
                # For a sale, sellers exit; for partition, sellers may also remain (joint),
                # but we conservatively keep them in the pool so subsequent legitimate
                # transfers are not falsely flagged.
                prior_buyers_pool |= buyers_set

            elif kind == "encumbrance":
                # Track for "open encumbrance" reporting; do NOT change ownership.
                open_encumbrances.append({
                    "doc_no": h["doc_no"],
                    "date": h["date"],
                    "nature": h["nature"],
                    "creditor": h["buyer"],   # in mortgages the "buyer" is the mortgagee
                    "borrower": h["seller"],  # the "seller" is the mortgagor
                    "released": False,
                    "release_doc_no": None,
                })

            elif kind == "encumbrance_release":
                # Best-effort: mark the most recent open encumbrance with a matching
                # creditor/borrower as released.
                released_any = False
                for enc in reversed(open_encumbrances):
                    if enc["released"]:
                        continue
                    enc_creditor = {enc["creditor"]} if enc["creditor"] else set()
                    enc_borrower = {enc["borrower"]} if enc["borrower"] else set()
                    if (
                        _parties_overlap(enc_creditor, sellers_set | buyers_set)
                        or _parties_overlap(enc_borrower, sellers_set | buyers_set)
                    ):
                        enc["released"] = True
                        enc["release_doc_no"] = h["doc_no"]
                        released_any = True
                        break
                if not released_any and open_encumbrances:
                    # Fallback: assume the oldest open encumbrance got released.
                    oldest_open = next((e for e in open_encumbrances if not e["released"]), None)
                    if oldest_open:
                        oldest_open["released"] = True
                        oldest_open["release_doc_no"] = h["doc_no"]
            # 'other' → no effect on ownership pool

        # Determine current owner: buyers of the most recent TRANSFER deed.
        current_owner = "Unknown"
        current_owner_basis_doc = None
        for h in reversed(sorted_history):
            if h.get("kind") == "transfer" and (h.get("buyers_list") or h.get("buyer")):
                current_owner = h["buyer"]
                current_owner_basis_doc = h["doc_no"]
                h["is_current_owner_source"] = True
                break

        # If no transfer deed was found at all, fall back to the latest non-encumbrance entry.
        if current_owner == "Unknown":
            for h in reversed(sorted_history):
                if h.get("kind") != "encumbrance":
                    if h.get("buyer") and h["buyer"] != "N/A":
                        current_owner = h["buyer"]
                        current_owner_basis_doc = h["doc_no"]
                        h["is_current_owner_source"] = True
                        break

        unique_owners = data["all_sellers"].union(data["all_buyers"])
        unreleased_encumbrances = [e for e in open_encumbrances if not e["released"]]

        # Aggregate audit verdict for this survey (used for the UI badge).
        if chain_breaks:
            verdict = "BROKEN_CHAIN"
        elif unreleased_encumbrances:
            verdict = "ENCUMBERED"
        elif current_owner == "Unknown":
            verdict = "INDETERMINATE"
        else:
            verdict = "CLEAR"

        results.append({
            "survey_number": sn,
            "total_transactions": data["transactions_count"],
            "current_owner": current_owner,
            "current_owner_basis_doc": current_owner_basis_doc,
            "unique_owners_count": len(unique_owners),
            "unique_owners_list": sorted(list(unique_owners)),
            "last_transaction_date": sorted_history[-1]["date"] if sorted_history else "N/A",
            "lineage": sorted_history,
            "audit": {
                "verdict": verdict,
                "chain_breaks": chain_breaks,
                "open_encumbrances": unreleased_encumbrances,
                "partition_events": partition_events,
                "transfer_count": sum(1 for h in sorted_history if h.get("kind") == "transfer"),
                "encumbrance_count": sum(1 for h in sorted_history if h.get("kind") == "encumbrance"),
            },
        })

    # Sort results by survey number numerically if possible
    def sn_sort_key(res):
        sn = res["survey_number"]
        match = re.match(r"(\d+)(?:/(\d+))?", sn)
        if match:
            base = int(match.group(1))
            sub = int(match.group(2)) if match.group(2) else 0
            return (base, sub)
        return (99999, sn)

    results.sort(key=sn_sort_key)

    return {"status": "success", "data": results}

