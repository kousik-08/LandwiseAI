import os
import json
import logging
import uuid
from typing import Optional

from fastapi import FastAPI, APIRouter, Request, HTTPException, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Local imports
from api.download_ec.handler import handle_download_ec, ECRequest
from api.validate.handler import (
    handle_validate, handle_validate_json, WorkflowRequest, 
    handle_verify_supporting_doc, handle_chat_with_doc, handle_validate_single,
    handle_get_global_hierarchy, handle_search_survey_timeline,
    handle_generate_report, handle_analyze_ec
)
from api.validate.hierarchy_generator import HierarchyGenerator
from api.getlandinfo.handler import handle_get_land_info, ReginetRequest
from api.validate.notes_handler import handle_save_node_note, handle_get_node_notes
from common.utils import Utils
from common.logger import RequestLogger
from common.errors import register_exception_handlers

# Load environment variables
load_dotenv()

# Setup Logger
logger = logging.getLogger(__name__)

# Initialize FastAPI App
app = FastAPI(title="PattaFlow")
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

app.mount("/files", StaticFiles(directory="outputs"), name="files")
app.mount("/input-files", StaticFiles(directory="inputs"), name="input-files")


# Create router with versioning
router = APIRouter(prefix="/api/v1")


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




@router.post("/download-ec")
def download_ec_endpoint(request: Request, body: ECRequest):
    return utils.construct_output(handle_download_ec(request, body))


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
    request_id: Optional[str] = Form(None)
):
    """
    Endpoint to ask questions about a specific document.
    """
    print(f"[*] chat-with-doc: doc_no={doc_no}, request_id={request_id}")
    try:
        history_list = json.loads(history)
    except:
        history_list = []
    return await handle_chat_with_doc(doc_no, message, history_list, request_id=request_id)


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


@router.get("/get-validation-results/{request_id}")
async def get_validation_results(request_id: str):
    """
    Retrieve validation results for a specific request ID.
    """
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


app.include_router(router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
