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


CACHE_INDEX_PATH = os.path.join("outputs", "validate_cache_index.json")
CACHE_PIPELINE_VERSION = "v1"


def _load_cache_index() -> dict:
    if not os.path.exists(CACHE_INDEX_PATH):
        return {}
    try:
        with open(CACHE_INDEX_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache_index(index: dict) -> None:
    os.makedirs(os.path.dirname(CACHE_INDEX_PATH), exist_ok=True)
    with open(CACHE_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


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
) -> str:
    ec_hash = _compute_file_hash_from_path(ec_pdf_path)
    docs_hash = _compute_dir_pdf_hash(registration_docs_dir)
    limit_part = "all" if transaction_limit in (None, 0) else str(transaction_limit)
    return f"local:{ec_hash}:{docs_hash}:tx={limit_part}"


def _make_cache_key_for_files_hashes(
    ec_hash: str,
    zip_hash: str,
    transaction_limit: Optional[int],
) -> str:
    limit_part = "all" if transaction_limit in (None, 0) else str(transaction_limit)
    return f"files:{ec_hash}:{zip_hash}:tx={limit_part}"


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

    # Configuration
    chunk_size = int(os.getenv("CHUNK_SIZE", 8))
    ec_json_path = os.path.join(processing_output_dir, "ec_final.json")
    matched_docs = []
    results = []
    matcher = None  # Initialize matcher to None for cleanup in finally block

    try:
        # 1. EC Processing
        yield event("step_start", step="ec_extraction", label="EC Extraction")
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
            yield event("step_complete", step="ec_extraction", status="success")
        except Exception as e:
            yield event(
                "log", message=f"EC Extraction Failed: {e}", step="ec_extraction"
            )
            yield event(
                "step_complete", step="ec_extraction", status="failed", error=str(e)
            )
            raise e  # Stop workflow on critical failure

        # 2. Document Matching
        yield event("step_start", step="matching", label="Document Matching")
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
            # If transaction_limit is None or negative, treat as 'all' (0)
            if transaction_limit is None or transaction_limit < 0:
                match_limit = int(os.getenv("MATCH_LIMIT", 0)) # Default to 0 (unlimited)
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

            # Persist matched PDFs to the global vault
            vault_dir = os.path.join("outputs", "storage", "vault")
            os.makedirs(vault_dir, exist_ok=True)
            for doc in matched_docs:
                src_path = doc.get("file_path")
                doc_no = doc.get("document_number")
                if src_path and doc_no and os.path.exists(src_path):
                    # Clean filename for the vault
                    safe_name = re.sub(r'[^a-zA-Z0-9]', '_', str(doc_no)) + ".pdf"
                    dst_path = os.path.join(vault_dir, safe_name)
                    try:
                        shutil.copy2(src_path, dst_path)
                        # Store the vault relative path
                        doc["vault_path"] = f"storage/vault/{safe_name}"
                    except Exception as e:
                        print(f"Failed to copy to vault: {e}")

            yield event("step_complete", step="matching", status="success")
        except Exception as e:
            yield event("log", message=f"Matching Failed: {e}", step="matching")
            yield event("step_complete", step="matching", status="failed", error=str(e))
            raise e

        # 3. Sale Deed Extraction
        yield event(
            "step_start", step="sale_deed_extraction", label="Sale Deed Extraction"
        )
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
            raise e

        # 3.5. Hierarchy Generation (Enriched with metadata)
        yield event("step_start", step="hierarchy", label="Hierarchy Generation")
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
            yield event("step_complete", step="hierarchy", status="success")
        except Exception as e:
            yield event("log", message=f"Hierarchy Generation Failed: {e}", step="hierarchy")
            yield event("step_complete", step="hierarchy", status="failed", error=str(e))
            # Hierarchy is optional

        # 4. Validation
        yield event("step_start", step="validation", label="Validation")
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
            yield event("step_complete", step="validation", status="success")
        except Exception as e:
            yield event("log", message=f"Validation Failed: {e}", step="validation")
            yield event(
                "step_complete", step="validation", status="failed", error=str(e)
            )
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
        # Note: 'result' events are part of the stream.
        # When not streaming, we capture this and wrap it using construct_output
        yield event("result", data=final_result)

    except Exception as e:
        # Top-level catch to ensure any unhandled errors are reported
        yield event("error", message=f"Workflow failed: {e}")
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
    processing_input_dir = os.path.join("inputs", "validate", processing_id)
    processing_output_dir = os.path.join("outputs", "validate", processing_id)

    os.makedirs(processing_input_dir, exist_ok=True)
    os.makedirs(processing_output_dir, exist_ok=True)

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
        # Validate required files
        if not ec_pdf_file:
            raise HTTPException(
                status_code=400, detail="ec_pdf_file is required for files type"
            )
        if not sale_deeds_zip:
            raise HTTPException(
                status_code=400, detail="sale_deeds_zip is required for files type"
            )

        # Save EC PDF to input folder and compute hash
        ec_pdf_filename = ec_pdf_file.filename or "ec.pdf"
        actual_ec_pdf_path = os.path.join(processing_input_dir, ec_pdf_filename)

        ec_bytes = await ec_pdf_file.read()
        with open(actual_ec_pdf_path, "wb") as f:
            f.write(ec_bytes)
        ec_content_hash = hashlib.sha256(ec_bytes).hexdigest()

        # Save ZIP as sale_deeds.zip and compute hash
        zip_path = os.path.join(processing_input_dir, "sale_deeds.zip")
        zip_bytes = await sale_deeds_zip.read()
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)
        zip_content_hash = hashlib.sha256(zip_bytes).hexdigest()

        # Extract ZIP to input directory
        # This avoids creating an extra 'sale_deeds' folder if the zip already contains it
        # If zip is flat, files go to processing_input_dir
        # If zip contains 'sale_deeds' folder, it goes to processing_input_dir/sale_deeds
        try:
            with zipfile.ZipFile(zip_path, "r") as zip_ref:
                zip_ref.extractall(processing_input_dir)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="Invalid ZIP file provided")

        # Smartly determine the registration_docs_dir
        # If extraction created a 'sale_deeds' folder, use that.
        # Otherwise, use the input root (assumes flat zip or other folder name).
        potential_subfolder = os.path.join(processing_input_dir, "sale_deeds")
        if os.path.isdir(potential_subfolder):
            actual_registration_docs_dir = potential_subfolder
        else:
            actual_registration_docs_dir = processing_input_dir

        # Log request
        logger.log_request(
            {
                "type": type,
                "ec_pdf_file": ec_pdf_file.filename,
                "sale_deeds_zip": sale_deeds_zip.filename,
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
    final_result_path: Optional[str] = None

    try:
        if type == "files" and ec_content_hash and zip_content_hash:
            cache_key = _make_cache_key_for_files_hashes(
                ec_content_hash, zip_content_hash, transaction_limit
            )
        elif type == "local_path":
            cache_key = _make_cache_key_for_local_paths(
                actual_ec_pdf_path, actual_registration_docs_dir, transaction_limit
            )
    except Exception as e:
        # If cache key computation fails, just log and continue without cache
        logger.log_error(f"Cache key computation failed: {e}")
        cache_key = None

    if cache_key:
        index = _load_cache_index()
        cache_entry = index.get(cache_key)
        if cache_entry and cache_entry.get("pipeline_version") == CACHE_PIPELINE_VERSION:
            final_result_path = cache_entry.get("final_result_path")
            if final_result_path and os.path.exists(final_result_path):
                try:
                    with open(final_result_path, "r", encoding="utf-8") as f:
                        cached_result = json.load(f)
                except Exception as e:
                    logger.log_error(f"Failed to load cached result: {e}")
                    cached_result = None

                if cached_result is not None:
                    # For streaming requests, return a tiny cached stream
                    if stream:
                        def cached_stream():
                            yield json.dumps(
                                {
                                    "type": "log",
                                    "message": f"Using cached result for request_id={cached_result.get('request_id')}",
                                }
                            ) + "\n"
                            yield json.dumps(
                                {
                                    "type": "result",
                                    "data": cached_result,
                                    "cached": True,
                                }
                            ) + "\n"

                        response = StreamingResponse(
                            cached_stream(),
                            media_type="application/x-ndjson",
                        )
                        duration = (time.time() - start_time) * 1000
                        logger.log_output(
                            duration_ms=duration,
                            success=True,
                            data={
                                "request_id": cached_result.get("request_id"),
                                "cache_hit": True,
                            },
                        )
                        return response

                    # Non-streaming: just return the cached result structure
                    duration = (time.time() - start_time) * 1000
                    logger.log_output(
                        duration_ms=duration,
                        success=True,
                        data={"request_id": cached_result.get("request_id"), "cache_hit": True},
                    )
                    return cached_result

    # If we reach here, either no cache_key or no usable cache entry; record target path so
    # the result can be reused next time.
    if cache_key:
        index = _load_cache_index()
        final_result_path = os.path.join(processing_output_dir, "final_result.json")
        index[cache_key] = {
            "request_id": processing_id,
            "final_result_path": final_result_path,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "pipeline_version": CACHE_PIPELINE_VERSION,
        }
        _save_cache_index(index)

    try:
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
    """
    logger = request.state.logger
    processing_id = request_id or str(uuid.uuid4())
    processing_output_dir = os.path.join("outputs", "analyze", processing_id)
    os.makedirs(processing_output_dir, exist_ok=True)

    actual_path = ec_pdf_path
    
    # CASE 1: File Uploaded
    if ec_pdf_file:
        input_dir = os.path.join("inputs", "analyze", processing_id)
        os.makedirs(input_dir, exist_ok=True)
        actual_path = os.path.join(input_dir, ec_pdf_file.filename)
        with open(actual_path, "wb") as f:
            content = await ec_pdf_file.read()
            f.write(content)
    
    # CASE 2: No path but Request ID provided (Look for EC in validation inputs)
    elif not actual_path and request_id:
        validation_input_dir = os.path.join("inputs", "validate", request_id)
        if os.path.isdir(validation_input_dir):
            # Try to find any PDF that might be the EC (usually saved by handle_validate)
            # handle_validate saves it as its original name.
            possible_files = [f for f in os.listdir(validation_input_dir) if f.lower().endswith('.pdf')]
            if possible_files:
                # Assuming the first PDF that isn't clearly a sale deed is the EC
                # In most cases, there's only one PDF in that root if the sale deeds are zips
                actual_path = os.path.join(validation_input_dir, possible_files[0])
            else:
                raise HTTPException(status_code=400, detail="No EC PDF found for this Request ID")
        else:
            raise HTTPException(status_code=400, detail=f"Request inputs folder not found for ID: {request_id}")

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

def resolve_pdf_path(doc_no: str, request_id: Optional[str] = None, hint: Optional[str] = None) -> Optional[str]:
    """
    Robustly resolves the absolute path to a document's PDF.
    Searches:
    1. Hint path (sanitized)
    2. Request-specific outputs
    3. Request-specific inputs
    4. Global vault
    """
    import os, re
    
    # Normalizer for filenames
    safe_name = re.sub(r'[^a-zA-Z0-9]', '_', str(doc_no)) + ".pdf"
    
    # 1. Try hint first if provided
    if hint:
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
            if c and os.path.exists(c):
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
            if os.path.exists(c):
                return c

    # 3. Try Global Vault
    vault_path = os.path.join("outputs", "storage", "vault", safe_name)
    if os.path.exists(vault_path):
        return vault_path
        
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
    """Helper to build the doc_map for a request."""
    import os, json
    doc_map = {}
    target_dir = os.path.join("outputs", "validate", request_id)
    results_path = os.path.join(target_dir, "results.json")
    
    # 1. Load from results.json
    if os.path.exists(results_path):
        try:
            with open(results_path, 'r', encoding='utf-8') as f:
                results_data = json.load(f)
                for res in results_data:
                    d_no = res.get('document_number')
                    f_path = res.get('file_path') or res.get('vault_path')
                    if d_no and f_path:
                        # Normalize to files/ prefix for outputs
                        if f_path.startswith("outputs/"): f_path = f_path[len("outputs/"):]
                        elif f_path.startswith("outputs\\"): f_path = f_path[len("outputs\\"):]
                        doc_map[d_no] = "files/" + f_path.replace('\\', '/')
        except Exception as e:
            print(f"Error loading results for map: {e}")

    # 2. Extract and Map all PDFs (Directory Scan)
    search_paths = [target_dir, os.path.join(target_dir, "matched_docs")]
    for s_path in search_paths:
        if os.path.exists(s_path):
            files = os.listdir(s_path)
            for file in files:
                if file.lower().endswith(".pdf"):
                    base = os.path.splitext(file)[0]
                    d_no_derived = base.replace('_', '/')
                    full_path = os.path.join(s_path, file)
                    rel_path = os.path.relpath(full_path, "outputs").replace('\\', '/')
                    if d_no_derived not in doc_map: doc_map[d_no_derived] = f"files/{rel_path}"
                    if base not in doc_map: doc_map[base] = f"files/{rel_path}"

    # 3. Search in Inputs directory
    input_dir = os.path.join("inputs", "validate", request_id)
    input_search_paths = [input_dir, os.path.join(input_dir, "sale_deeds")]
    for s_path in input_search_paths:
        if os.path.exists(s_path):
            files = os.listdir(s_path)
            for file in files:
                if file.lower().endswith(".pdf"):
                    base = os.path.splitext(file)[0]
                    d_no_derived = base.replace('_', '/').replace('-', '/')
                    full_path = os.path.join(s_path, file)
                    rel_path = os.path.relpath(full_path, "inputs").replace('\\', '/')
                    val = f"input-files/{rel_path}"
                    if d_no_derived not in doc_map:
                        doc_map[d_no_derived] = val
                    if base not in doc_map:
                        doc_map[base] = val

    # 4. Global Vault
    vault_dir = os.path.join("outputs", "storage", "vault")
    if os.path.exists(vault_dir):
        files = os.listdir(vault_dir)
        for file in files:
            if file.lower().endswith(".pdf"):
                base = os.path.splitext(file)[0]
                full_path = os.path.join(vault_dir, file)
                rel_path = os.path.relpath(full_path, "outputs").replace('\\', '/')
                if base not in doc_map:
                    doc_map[base] = f"files/{rel_path}"
    
    return doc_map

async def handle_get_global_hierarchy(request_id: str):
    hierarchy_path = os.path.join("outputs", "validate", request_id, "hierarchy_tree.json")
    if not os.path.exists(hierarchy_path):
        raise HTTPException(status_code=404, detail="Hierarchy data not available")
    
    with open(hierarchy_path, 'r', encoding='utf-8') as f:
        hierarchy_data = json.load(f)
    
    doc_map = get_doc_map(request_id)
    gen = HierarchyGenerator(output_dir="")
    gen.node_counter = 0
    rf_data = gen._generate_react_flow_data(hierarchy_data, doc_map=doc_map)
    
    return {"status": "success", "react_flow_data": rf_data}

async def handle_search_survey_timeline(request_id: str, survey_number: str, limit: Optional[int] = None):
    hierarchy_path = os.path.join("outputs", "validate", request_id, "hierarchy_tree.json")
    if not os.path.exists(hierarchy_path):
        raise HTTPException(status_code=404, detail="Hierarchy timeline data is not available.")
    
    with open(hierarchy_path, 'r', encoding='utf-8') as f:
        hierarchy_data = json.load(f)
    
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
        
        # Save report as Markdown
        report_filename = "legal_opinion_report.md"
        report_path = os.path.join(target_dir, report_filename)
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(report_content)
            
        return {
            "status": "success",
            "report_md": report_content,
            "report_url": f"files/validate/{request_id}/{report_filename}"
        }
    except Exception as e:
        print(f"[!] Report generation failure: {str(e)}")
        raise HTTPException(status_code=500, detail=f"AI drafting failed: {str(e)}")

