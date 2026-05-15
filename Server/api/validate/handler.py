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
                message="Extracting Sale Deed details...",
                step="sale_deed_extraction",
            )
            sd_proc = SaleDeedProcessor(output_dir=processing_output_dir)

            # process_matched_list(matched_docs) replaced with granular loop
            total_docs = len(matched_docs)
            
            if total_docs >= 2:
                from concurrent.futures import ThreadPoolExecutor
                yield event("log", message=f"Running parallel extraction for {total_docs} documents with 3 workers...", step="sale_deed_extraction")
                
                with ThreadPoolExecutor(max_workers=3) as executor:
                    # Submit all tasks
                    futures = {executor.submit(sd_proc.process_file, doc.get("file_path")): doc for doc in matched_docs}
                    
                    done_count = 0
                    for future in futures:
                        doc = futures[future]
                        doc_num = doc.get("document_number", "Unknown")
                        # We wait for each but they are running in parallel
                        future.result() 
                        done_count += 1
                        yield event(
                            "log",
                            message=f"[{done_count}/{total_docs}] Extracted metadata for Document {doc_num}",
                            step="sale_deed_extraction"
                        )
            else:
                for idx, doc in enumerate(matched_docs, 1):
                    doc_num = doc.get("document_number", "Unknown")
                    file_path = doc.get("file_path")

                    # Yield progress log
                    yield event(
                        "log",
                        message=f"[{idx}/{total_docs}] Extracting metadata for Document {doc_num}...",
                        step="sale_deed_extraction",
                    )

                    # Process individual file
                    sd_proc.process_file(file_path)

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
            validator = Validator(output_dir=processing_output_dir)
            
            total_docs = len(matched_docs)
            results = []
            
            # Prepare EC lookup once for both paths
            if not os.path.exists(ec_json_path):
                ec_lookup = {}
            else:
                with open(ec_json_path, "r", encoding="utf-8") as f:
                    ec_data = json.load(f)
                ec_lookup = {entry.get("document_number"): entry for entry in ec_data}

            if total_docs >= 2:
                yield event("log", message=f"Running parallel validation for {total_docs} documents...", step="validation")
                from concurrent.futures import ThreadPoolExecutor
                
                with ThreadPoolExecutor(max_workers=3) as executor:
                    future_to_doc = {executor.submit(validator.validate_single_doc, doc, ec_json_path, visual_debug, ec_lookup): doc for doc in matched_docs}
                    
                    completed = 0
                    for future in future_to_doc:
                        res = future.result()
                        if res:
                            results.append(res)
                            completed += 1
                            status = "[MATCHED]" if res.get("match") else "[ISSUE]"
                            yield event("log", message=f"[{completed}/{total_docs}] Validated {res['document_number']}: {status}", step="validation")
                            # Yield incremental result
                            yield event("partial_result", data=res)
            else:
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
                            from datetime import datetime as _dt
                            if isinstance(enc_date, str):
                                enc_date = _dt.fromisoformat(enc_date).date()
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
                            from datetime import datetime as _dt
                            if isinstance(reg_date, str):
                                reg_date = _dt.fromisoformat(reg_date).date()
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
            # Return StreamingResponse directly
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

async def handle_chat_with_doc(doc_no: str, message: str, history: list = None, request_id: Optional[str] = None):
    """
    Handles a chat query about a specific document.
    """
    from common.gemini_helper import GeminiHelper
    
    file_path = resolve_pdf_path(doc_no, request_id=request_id)
    
    if not file_path:
        print(f"[!] PDF not found for chat: {doc_no} (Target ID: {request_id})")
        raise HTTPException(status_code=404, detail=f"Document PDF not found for {doc_no}. Ensure it has been uploaded or processed.")

    print(f"[*] Chatting with PDF: {file_path}")
    gemini = GeminiHelper(model_id="gemini-2.5-flash-lite") # Use flash for large context


    
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
        response = gemini.generate_from_file(file_path, context_prompt, display_name=f"Deed_{doc_no}")
        return {"response": response}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    # Canonical location is S3 key outputs/validate/<rid>/hierarchy_tree.json.
    hierarchy_key = f"outputs/validate/{request_id}/hierarchy_tree.json"
    hierarchy_data = read_json(hierarchy_key, default=None)

    if hierarchy_data is None:
        # Fallback to DB-persisted AnalysisResult (some runs persist it both ways).
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
        raise HTTPException(status_code=404, detail="Hierarchy data not available")
    
    doc_map = get_doc_map(request_id)
    gen = HierarchyGenerator(output_dir="")
    gen.node_counter = 0
    rf_data = gen._generate_react_flow_data(hierarchy_data, doc_map=doc_map)

    # 3. Load validation results from S3 (canonical store).
    s3_prefix = f"outputs/validate/{request_id}"
    validation_results = read_json(f"{s3_prefix}/results.json", default=None)
    if not validation_results:
        final_data = read_json(f"{s3_prefix}/final_result.json", default=None)
        if isinstance(final_data, dict):
            validation_results = final_data.get("results", []) or []
        else:
            validation_results = []

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

    # 4. Load EC final data for Ownership Tabs
    ec_final = read_json(f"{s3_prefix}/ec_final.json", default=None) or []

    return {
        "status": "success",
        "react_flow_data": rf_data,
        "validation_results": validation_results,
        "ec_final": ec_final,
        "request_id": request_id
    }

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
    """
    from common.gemini_helper import GeminiHelper
    from prompts.opinion_prompts import OPINION_REPORT_PROMPT
    
    # 1. Load Data
    target_dir = os.path.join("outputs", "validate", request_id)
    hierarchy_path = os.path.join(target_dir, "hierarchy_tree.json")
    results_path = os.path.join(target_dir, "results.json")
    
    if not os.path.exists(hierarchy_path):
        print(f"[!] Hierarchy missing for report: {hierarchy_path}")
        raise HTTPException(status_code=404, detail="Hierarchy data not available. Please complete validation first.")

    with open(hierarchy_path, 'r', encoding='utf-8') as f:
        hierarchy_data = json.load(f)

    validation_results = []
    if os.path.exists(results_path):
        with open(results_path, 'r', encoding='utf-8') as f:
            validation_results = json.load(f)

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
    for entry in flattened_history:
        doc_no = entry.get("Doc_No", "").replace('/', '_')
        metadata_filename = f"{doc_no}_metadata.txt"
        metadata_path = os.path.join(target_dir, metadata_filename)
        
        # If not there, check matched_docs subfolder
        if not os.path.exists(metadata_path):
             metadata_path = os.path.join(target_dir, "matched_docs", metadata_filename)

        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    entry["Full_Metadata"] = f.read()
            except: pass

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
    gemini = GeminiHelper(model_id="gemini-2.5-flash") # Use standard flash for drafting
    
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
    "memo of satisfaction", "cancellation of mortgage"
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

