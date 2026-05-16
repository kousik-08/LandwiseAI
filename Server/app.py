import os
import json
import logging
import uuid
from typing import Optional

from fastapi import FastAPI, APIRouter, Request, HTTPException, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from common.storage import get_storage
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Local imports
from api.download_ec.handler import handle_download_ec, ECRequest
from api.validate.handler import (
    handle_validate, handle_validate_json, WorkflowRequest, 
    handle_verify_supporting_doc, handle_chat_with_doc, handle_validate_single,
    handle_get_global_hierarchy, handle_search_survey_timeline,
    handle_generate_report, handle_analyze_ec, handle_get_survey_ownership
)
from api.validate.risk_score_engine import handle_get_risk_score
from api.validate.hierarchy_generator import HierarchyGenerator
from api.getlandinfo.handler import handle_get_land_info, ReginetRequest
from api.validate.notes_handler import handle_save_node_note, handle_get_node_notes
from common.utils import Utils
from common.logger import RequestLogger
from common.errors import register_exception_handlers
from api.landwise.router import router as landwise_router
from common.database import Base, engine
from sqlalchemy import text
import common.models  # Legacy tables
import common.landwise_models  # 20 new Landwise tables
from api.auth.router import router as auth_router

# Create all tables (legacy + new Landwise schema)
try:
    print("[*] Synchronizing database tables...")
    Base.metadata.create_all(bind=engine)
    print("[+] Database tables synchronized.")
except Exception as e:
    print(f"[!] Warning: Database synchronization failed: {e}")
    print("[!] Ensure Postgres is running and DATABASE_URL is correct.")

# Idempotent column-level migrations. create_all() only creates missing
# tables — it does NOT add columns to existing tables, so any new columns
# defined on existing models must be applied here with ADD COLUMN IF NOT
# EXISTS so older deployments pick them up on startup.
_COLUMN_MIGRATIONS = [
    "ALTER TABLE parcels ADD COLUMN IF NOT EXISTS risk_score_data JSONB",
    "ALTER TABLE parcels ADD COLUMN IF NOT EXISTS risk_score_computed_at TIMESTAMPTZ",
    "ALTER TABLE lw_documents ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(10) DEFAULT 'local'",
    "ALTER TABLE legal_opinions ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(10) DEFAULT 'local'",
]
for _stmt in _COLUMN_MIGRATIONS:
    try:
        with engine.begin() as _conn:
            _conn.execute(text(_stmt))
    except Exception as _e:
        print(f"[!] Column migration skipped: {_stmt!r} -> {_e}")
print("[+] Column-level migrations applied.")


# Load environment variables
load_dotenv()

# Setup Logger
logger = logging.getLogger(__name__)

# Initialize FastAPI App
app = FastAPI(title="LandwiseAI")
Utils.setup_directories()
register_exception_handlers(app)

# Global Utility Instance
utils = Utils()

# Request Models
class SearchRequest(BaseModel):
    survey_number: str
    request_id: str
    limit: Optional[int] = Field(default=None, description="Limit to last N transactions")

class NoteRequest(BaseModel):
    doc_no: str
    note: str

@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id

    # Log incoming request to terminal immediately
    print(f"[REQ] {request.method} {request.url.path} request_id={request_id}")

    # Split logs by endpoint under .logs/<endpoint>/
    path = request.url.path or ""
    endpoint = "other"
    if path.startswith("/api/v1/"):
        endpoint = path[len("/api/v1/") :].split("/", 1)[0] or "other"
    log_dir = os.path.join(".logs", endpoint)

    # Initialize logger and attach to request state
    req_logger = RequestLogger(request_id, log_dir=log_dir)
    request.state.logger = req_logger

    response = await call_next(request)

    response.headers["X-Request-ID"] = request_id
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_storage_backend = (os.environ.get("STORAGE_BACKEND") or "local").strip().lower()

# Origins allowed to read presigned-redirect responses. FastAPI's
# CORSMiddleware does not always attach CORS headers to 3xx responses,
# so we add them manually below.
_ALLOWED_ORIGINS = {
    "https://staging.d1sd2m4ye8eyia.amplifyapp.com",
    "http://localhost:8080",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:8080",
}


def _cors_redirect_headers(request: Request) -> dict:
    origin = request.headers.get("origin", "")
    if origin in _ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return {}


if _storage_backend == "s3":
    @app.get("/files/{key:path}")
    async def serve_output_file(key: str, request: Request):
        storage = get_storage()
        full_key = f"outputs/{key}"
        if not storage.exists(full_key):
            raise HTTPException(status_code=404, detail="Not found")
        return RedirectResponse(
            url=storage.presigned_url(full_key),
            status_code=302,
            headers=_cors_redirect_headers(request),
        )

    @app.get("/input-files/{key:path}")
    async def serve_input_file(key: str, request: Request):
        storage = get_storage()
        full_key = f"inputs/{key}"
        if not storage.exists(full_key):
            raise HTTPException(status_code=404, detail="Not found")
        return RedirectResponse(
            url=storage.presigned_url(full_key),
            status_code=302,
            headers=_cors_redirect_headers(request),
        )
else:
    app.mount("/files", StaticFiles(directory="outputs"), name="files")
    app.mount("/input-files", StaticFiles(directory="inputs"), name="input-files")


# Create router with versioning
router = APIRouter(prefix="/api/v1")

# Include Landwise router
app.include_router(landwise_router)
app.include_router(auth_router, prefix="/api/v1")


@router.get("/health")
async def health_check():
    return {"status": "ok"}


@router.post("/validate-single")
async def validate_single_endpoint(request: Request):
    """
    Endpoint to trigger validation for a single document.
    """
    try:
        body = await request.json()
        logger.info(f"[*] validate-single-doc request body: {body}")
        result = await handle_validate_single(request, body)
        return utils.construct_output(result)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        logger.error(f"Error in validate-single: {e}")
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {str(e)}")


@router.post("/validate")
async def validate_endpoint(request: Request):
    """
    Validate endpoint supports two input types:
    - type="local_path": Send JSON body with ec_pdf_path and registration_docs_dir
    - type="files": Send multipart/form-data with ec_pdf_file and sale_deeds_zip
    """
    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        # Handle JSON request (local_path type)
        body = await request.json()
        response = await handle_validate_json(request, WorkflowRequest(**body))
    else:
        # Handle Form data (files type)
        form_data = await request.form()
        type_val = form_data.get("type")
        if not type_val:
            raise HTTPException(status_code=400, detail="type field is required")

        stream_val = form_data.get("stream", "false")
        stream_bool = (
            stream_val.lower() == "true"
            if isinstance(stream_val, str)
            else bool(stream_val)
        )

        visual_debug_val = form_data.get("visual_debug", "false")
        visual_debug_bool = (
            visual_debug_val.lower() == "true"
            if isinstance(visual_debug_val, str)
            else bool(visual_debug_val)
        )

        transaction_limit_val = form_data.get("transaction_limit")
        transaction_limit = None
        if transaction_limit_val and transaction_limit_val.lower() != "null":
            try:
                transaction_limit = int(transaction_limit_val)
            except ValueError:
                transaction_limit = 0 if transaction_limit_val.lower() == "all" else None

        ec_pdf_file_obj = form_data.get("ec_pdf_file")
        sale_deeds_zip_obj = form_data.get("sale_deeds_zip")

        response = await handle_validate(
            request=request,
            type=type_val,
            stream=stream_bool,
            visual_debug=visual_debug_bool,
            ec_pdf_path=form_data.get("ec_pdf_path"),
            registration_docs_dir=form_data.get("registration_docs_dir"),
            ec_pdf_file=ec_pdf_file_obj,
            sale_deeds_zip=sale_deeds_zip_obj,
            transaction_limit=transaction_limit,
        )

    # If it's a streaming response, return it directly.
    if isinstance(response, StreamingResponse):
        return response
    return utils.construct_output(response)


@router.post("/validate-ec-only")
async def validate_ec_only_endpoint(
    request: Request,
    ec_pdf_file: UploadFile = File(...),
    transaction_limit: Optional[int] = Form(None),
    visual_debug: Optional[bool] = Form(False),
):
    """
    EC-only validation endpoint.
    Accepts only an EC PDF upload and generates hierarchy without requiring deed ZIP.
    """
    # Normalize transaction_limit similar to /validate
    tx_limit_int: Optional[int] = None
    if isinstance(transaction_limit, str):
        val = transaction_limit.strip().lower()
        if val and val != "null":
            try:
                tx_limit_int = int(val)
            except ValueError:
                tx_limit_int = 0 if val == "all" else None
    else:
        tx_limit_int = transaction_limit

    result = await handle_validate(
        request=request,
        type="files",
        stream=False,
        ec_pdf_file=ec_pdf_file,
        sale_deeds_zip=None,
        visual_debug=bool(visual_debug),
        transaction_limit=tx_limit_int,
    )
    return utils.construct_output(result)




@router.post("/download-ec")
def download_ec_endpoint(request: Request, body: ECRequest):
    return utils.construct_output(handle_download_ec(request, body))


@router.get("/workflow-checkpoint/{request_id}")
def get_workflow_checkpoint(request_id: str, kind: str = "validate"):
    """Return the latest workflow checkpoint for a request, read from storage."""
    from common.workflow_checkpoint import load_checkpoint
    cp = load_checkpoint(request_id, kind=kind)
    if not cp:
        raise HTTPException(status_code=404, detail="No checkpoint found for this request_id")
    return cp


@router.post("/getlandinfo")
def get_land_info_endpoint(request: Request, body: ReginetRequest):
    """
    Fetches land info based on coordinates.
    """
    return utils.construct_output(handle_get_land_info(request, body))


@router.post("/verify-supporting-doc")
async def verify_supporting_doc_endpoint(
    request: Request,
    file: UploadFile = File(...),
    metadata: str = Form(...)
):
    """
    Endpoint to verify a supporting document against deed metadata.
    """
    return await handle_verify_supporting_doc(file, metadata)


@router.post("/analyze-ec")
async def analyze_ec_endpoint(
    request: Request,
    ec_pdf_file: Optional[UploadFile] = File(None),
    ec_pdf_path: Optional[str] = Form(None),
    request_id: Optional[str] = Form(None)
):
    """
    Endpoint to trigger specialized historical value analysis of an EC.
    """
    return await handle_analyze_ec(request, ec_pdf_path, ec_pdf_file, request_id)


@router.post("/chat-with-doc")
async def chat_with_doc_endpoint(
    request: Request,
    doc_no: str = Form(...),
    message: str = Form(...),
    history: str = Form("[]"),
    request_id: Optional[str] = Form(None),
    parcel_id: Optional[str] = Form(None)
):
    """
    Endpoint to ask questions about a specific document and save history.
    """
    print(f"[*] chat-with-doc: doc_no={doc_no}, request_id={request_id}")
    try:
        history_list = json.loads(history)
    except:
        history_list = []
    
    # Save User Message to DB
    from common.database import SessionLocal
    from common.landwise_models import ChatMessage
    db = SessionLocal()
    try:
        user_msg = ChatMessage(
            doc_no=doc_no,
            parcel_id=parcel_id,
            role="user",
            content=message
        )
        db.add(user_msg)
        db.commit()
    except Exception as e:
        print(f"[!] Error saving user message: {e}")
    finally:
        db.close()

    response_data = await handle_chat_with_doc(doc_no, message, history_list, request_id=request_id)
    
    # Save Assistant Response to DB
    db = SessionLocal()
    try:
        assistant_msg = ChatMessage(
            doc_no=doc_no,
            parcel_id=parcel_id,
            role="assistant",
            content=response_data.get("response", "")
        )
        db.add(assistant_msg)
        db.commit()
    except Exception as e:
        print(f"[!] Error saving assistant message: {e}")
    finally:
        db.close()

    return response_data


@router.post("/save-node-note")
async def save_node_note_endpoint(body: NoteRequest):
    """
    Endpoint to save a note for a specific node.
    """
    return handle_save_node_note(body.doc_no, body.note)


@router.get("/get-node-notes")
async def get_node_notes_endpoint():
    """
    Endpoint to retrieve all node notes.
    """
    return handle_get_node_notes()


@router.post("/wipe-survey-data/{parcel_id}")
async def wipe_survey_data(parcel_id: str):
    """
    Endpoint to wipe all registry/survey data for a parcel to start fresh.
    """
    from common.database import SessionLocal
    from common.landwise_models import (
        Parcel, OwnershipTransfer, Owner, Encumbrance, AnalysisResult,
        ExtractedField, DocumentAnnotation, RiskFlag,
        ConsistencyCheck, ConsistencyMismatch, LegalOpinion,
        OpinionSection, ChecklistItem, LandwiseDocument
    )
    db = SessionLocal()
    try:
        deleted_counts = {}

        # Reset Parcel status and scores
        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if parcel:
            parcel.status = 'pending'
            parcel.risk_score = 0
            parcel.completion_score = 0
            parcel.document_completeness_pct = 0
            parcel.last_analysis_request_id = None
            db.add(parcel)

        # Clear ownership and hierarchy data
        deleted_counts['ownership_transfers'] = db.query(OwnershipTransfer).filter(OwnershipTransfer.parcel_id == parcel_id).delete()
        deleted_counts['owners'] = db.query(Owner).filter(Owner.parcel_id == parcel_id).delete()
        deleted_counts['encumbrances'] = db.query(Encumbrance).filter(Encumbrance.parcel_id == parcel_id).delete()

        # Clear extracted fields and annotations (document metadata)
        # ExtractedFields are linked to documents, so we delete them via document_id
        doc_ids = [d.id for d in db.query(LandwiseDocument.id).filter(LandwiseDocument.parcel_id == parcel_id).all()]
        if doc_ids:
            deleted_counts['extracted_fields'] = db.query(ExtractedField).filter(ExtractedField.document_id.in_(doc_ids)).delete(synchronize_session=False)
        else:
            deleted_counts['extracted_fields'] = 0
            
        deleted_counts['document_annotations'] = db.query(DocumentAnnotation).filter(DocumentAnnotation.parcel_id == parcel_id).delete()

        # Clear risk and consistency data
        deleted_counts['risk_flags'] = db.query(RiskFlag).filter(RiskFlag.parcel_id == parcel_id).delete()
        deleted_counts['consistency_checks'] = db.query(ConsistencyCheck).filter(ConsistencyCheck.parcel_id == parcel_id).delete()
        deleted_counts['consistency_mismatches'] = db.query(ConsistencyMismatch).filter(ConsistencyMismatch.parcel_id == parcel_id).delete()

        # Clear legal opinion data
        opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
        if opinion:
            db.query(OpinionSection).filter(OpinionSection.opinion_id == opinion.id).delete()
            db.delete(opinion)
            deleted_counts['legal_opinions'] = 1
        else:
            deleted_counts['legal_opinions'] = 0

        deleted_counts['checklist_items'] = db.query(ChecklistItem).filter(ChecklistItem.parcel_id == parcel_id).delete()

        # Clear analysis results (validation results, hierarchy tree, etc.)
        deleted_counts['analysis_results'] = db.query(AnalysisResult).filter(AnalysisResult.parcel_id == parcel_id).delete()

        # Reset document extraction status (keep documents but mark for re-extraction)
        docs = db.query(LandwiseDocument).filter(LandwiseDocument.parcel_id == parcel_id).all()
        for doc in docs:
            doc.extraction_status = 'pending'
            doc.extracted_data = None
            db.add(doc)
        deleted_counts['documents_reset'] = len(docs)

        # 4. Wipe local files for this parcel if request_id is known
        request_id = parcel.last_analysis_request_id if parcel else None
        if request_id:
            folders_to_clear = [
                os.path.join("outputs", "validate", request_id),
                os.path.join("inputs", "validate", request_id)
            ]
            for folder in folders_to_clear:
                if os.path.exists(folder):
                    try:
                        #shutil.rmtree(folder)
                        deleted_counts[f'folder_cleared_{os.path.basename(folder)}'] = True
                    except Exception as e:
                        print(f"Failed to delete {folder}: {e}")

        db.commit()
        return {"status": "success", "message": "Survey and registry data wiped for this parcel.", "deleted": deleted_counts}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/get-validation-results/{request_id}")
async def get_validation_results(request_id: str):
    """
    Retrieve validation results for a specific request ID.
    """
    from common.models import ValidationResult
    from common.database import SessionLocal
    
    db = SessionLocal()
    try:
        results = db.query(ValidationResult).filter(ValidationResult.request_id == request_id).all()
        if results:
            return [
                {
                    "document_number": r.document_number,
                    "match": r.match,
                    "validation_result": {
                        "trustability_score": r.trustability_score,
                        "comparisons": r.comparisons
                    },
                    "reason_for_failure": r.reason_for_failure,
                    "file_path": r.file_path,
                    "vault_path": r.vault_path
                } for r in results
            ]
    finally:
        db.close()

    results_path = os.path.join("outputs", "validate", request_id, "results.json")
    if os.path.exists(results_path):
        try:
            with open(results_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error reading results: {str(e)}")
    return []


@router.get("/get-global-hierarchy/{request_id}")
async def get_global_hierarchy(request_id: str):
    """
    Retrieve the entire hierarchy for a request ID as React Flow data.
    """
    return await handle_get_global_hierarchy(request_id)



@router.post("/search-survey-timeline")
async def search_survey_timeline_endpoint(request: Request):
    """
    Search for a survey number's complete timeline in the hierarchy data.
    """
    try:
        body = await request.json()
        search_req = SearchRequest(**body)
        return await handle_search_survey_timeline(
            search_req.request_id, 
            search_req.survey_number, 
            limit=search_req.limit
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return utils.construct_output({
            "status": "error",
            "message": str(e)
        })



@router.post("/generate-report/{request_id}")
async def generate_report_endpoint(request_id: str):
    """
    Endpoint to trigger AI generation of a formal legal opinion report.
    """
    return await handle_generate_report(request_id)


@router.get("/get-survey-ownership/{request_id}")
async def get_survey_ownership_endpoint(request_id: str):
    """
    Endpoint to retrieve ownership statistics for all survey numbers.
    """
    return await handle_get_survey_ownership(request_id)


@router.get("/get-risk-score/{request_id}")
async def get_risk_score_endpoint(request_id: str, force: bool = False):
    """
    Returns the Title Health Score (0-100) with grade and AI summary.

    - On the first call, runs the full pipeline (LLM-backed) and caches the
      result on the parcel row (risk_score_data) and to a file.
    - Subsequent calls return the cached result instantly.
    - Pass ?force=true to bypass cache and recompute.
    """
    return await handle_get_risk_score(request_id, force=force)


app.include_router(router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
