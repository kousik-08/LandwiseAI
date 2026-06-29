# Pattaflow

This project provides an automated pipeline for extracting, matching, and analyzing land registration documents using Google Gemini. It utilizes a modular, class-based architecture to handle complex document processing workflows.

## Project Structure

- `api/`: API route handlers and business logic.
  - `download_ec/`: Logic for downloading EC PDFs from TNGIS.
  - `getlandinfo/`: Logic for retrieving land information from coordinates.
  - `validate/`: Core validation logic, including EC extraction, matching, and deed analysis.
- `common/`: Shared utilities.
  - `gemini_helper.py`: Wrapper for the Gemini SDK.
  - `utils.py`: Common helper functions and response formatting.
  - `logger.py`: Request-scoped logging with endpoint-based organization.
  - `errors.py`: Global exception handlers for standardized error responses.
- `prompts/`: Standardized prompt templates for LLM interactions.
- `app.py`: The main orchestration script that acts as the FastAPI application and entry point.
- `outputs/`: Output folder where results are organized by request ID.
  - `validate/{request_id}/`: Validation workflow outputs for each request.
    - `ec_final.json`: Extracted EC data
    - `matched_docs/`: Matched PDF documents
    - `sale_deeds/`: Extracted sale deed PDFs (when using file uploads)
    - `*_metadata.txt`: Extracted metadata for each document
    - `*_validation.json`: Validation results for each document
- `inputs/`: Input folder for storing EC PDFs and Registration Documents (used for local_path type).
- `.logs/`: Request logs organized by endpoint.
  - `validate/`: Logs for validation requests
  - `download-ec/`: Logs for EC download requests
  - `getlandinfo/`: Logs for land info requests
  - `other/`: Logs for other endpoints

## Workflow Explained

The pipeline executes in five main steps:

1.  **EC Extraction**: The system reads the master EC PDF in chunks, uses Gemini to identify all transactions, and saves them to a structured JSON file.
2.  **Document Matching**: A unique `request_id` (UUID) is generated for each API request. The system matches the transactions from the EC JSON with registration PDFs in the local library or uploaded files.
3.  **Detailed Analysis**: Matched PDFs are processed. The system extracts detailed Tamil-script metadata (names, dates, IDs) from the deeds.
4.  **Validation & Visual Debugging**: The system compares the extracted metadata against the original EC record using Gemini to verify consistency. If `visual_debug` is enabled and a mismatch is found, the system:
    - Overlays a reference grid on the relevant document page.
    - Uses Gemini's vision capabilities to locate the exact mismatched information.
    - Generates an annotated PDF with the mismatch boxed and highlighted.
5.  **Consolidation**: All final results (raw text, JSON, metadata, and annotated PDFs) are consolidated into the `outputs/validate/{request_id}/` folder.

Each request is logged with its unique request ID, and logs are organized by endpoint in the `.logs/` directory.

## Setup & Usage

### 1. Requirements

- Python 3.9+
- Gemini API Key
- [Ollama](https://ollama.com/) installed and running locally for validation.

### 2. Installation

```bash
pip install -r requirements.txt
```

### 3. Configuration

Create a `.env` file in the root directory (see `.env.template`):

```env
# Google Gemini
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite

# Local LLM (for Validation)
OLLAMA_URL=http://localhost:11434
VALIDATOR_MODEL=gemma3:1b

# Processing
CHUNK_SIZE=8

# TNGIS API Endpoints
TNGIS_EC_API_URL=https://tngis.tn.gov.in/apps/gi_viewer_api/api/encumbrance_certificate
TNGIS_LANDINFO_API_URL=https://tngis.tn.gov.in/apps/thematic_viewer_api/v1/getfeatureInfo
```

### 4. Running the Application

Start the FastAPI server:

```bash
uvicorn app:app --reload
```

## API Documentation

### Validate Workflow

**Endpoint:** `POST /api/v1/validate`

Triggers the full processing workflow: EC Extraction -> matching -> Deed Extraction -> Validation.

The endpoint supports two input types:

#### Type 1: Local Path (for testing)

Send a JSON request with `Content-Type: application/json`:

```json
{
  "type": "local_path",
  "ec_pdf_path": "inputs/47.pdf",
  "registration_docs_dir": "inputs/Registration Document",
  "stream": false
}
```

**Fields:**

- `type`: Must be `"local_path"`
- `ec_pdf_path`: Path to the EC PDF file (relative to project root)
- `registration_docs_dir`: Path to directory containing sale deed PDFs
- `stream`: (optional) Set to `true` for streaming response with progress updates

#### Type 2: File Upload (for production)

Send a multipart/form-data request with file uploads:

**Form Fields:**

- `type`: Must be `"files"`
- `ec_pdf_file`: EC PDF file (file upload)
- `sale_deeds_zip`: ZIP file containing sale deed PDFs (file upload)
- `stream`: (optional) Set to `"true"` for streaming response

**Example using curl:**

```bash
curl -X POST "http://localhost:8000/api/v1/validate" \
  -F "type=files" \
  -F "ec_pdf_file=@ec.pdf" \
  -F "sale_deeds_zip=@sale_deeds.zip" \
  -F "stream=false"
```

**File Organization:**
When using `type="files"`, files are organized as follows:

- EC PDF: `outputs/validate/{request_id}/{ec_filename}.pdf`
- Sale Deeds: `outputs/validate/{request_id}/sale_deeds/` (extracted from ZIP)

**Response:**
Returns a JSON object containing:

```json
{
  "status": "success",
  "output_dir": "outputs/validate/{request_id}",
  "request_id": "{request_id}",
  "results": [
    {
      "document_number": "2420/2022",
      "match": true,
      "file_path": "validate/{request_id}/matched_docs/2420_2022.pdf",
      "validation_result": { ... }
    }
  ]
}
```

**Streaming Response:**
When `stream=true`, the response is a newline-delimited JSON stream (`application/x-ndjson`) with progress updates:

- `step_start`: A workflow step has started
- `step_complete`: A workflow step has completed
- `log`: General log message
- `sub_log`: Sub-step log message
- `result`: Final result data
- `error`: Error occurred

### Download EC

**Endpoint:** `POST /api/v1/download-ec`

Downloads the Encumbrance Certificate (EC) PDF from TNGIS based on local government codes.

**Request Body:**

```json
{
  "district_code": "04",
  "taluk_code": "01",
  "village_code": "084",
  "survey_no": "123",
  "sub_div": "-"
}
```

**Response:**
Returns a JSON object with the success status and the local path to the downloaded PDF.

### Get Land Info

**Endpoint:** `POST /api/v1/getlandinfo`

Fetches land information (District, Taluk, Village, Survey Number) based on geographic coordinates.

**Request Body:**

```json
{
  "lat": 13.0827,
  "lng": 80.2707
}
```

## Logging & Error Handling

### 1. Request-Scoped Logging

- Every incoming request generates a unique **Request ID** (UUID).
- Logs are organized by endpoint in the `.logs/` directory:
  - `.logs/validate/{request_id}.log` - Validation requests
  - `.logs/download-ec/{request_id}.log` - EC download requests
  - `.logs/getlandinfo/{request_id}.log` - Land info requests
  - `.logs/other/{request_id}.log` - Other endpoints
- **File Format:** Newline-delimited JSON containing:
  - Request payloads
  - Processing stages and status
  - Duration metrics
  - Errors and exceptions
- **Terminal Output:** Each request is immediately logged to the terminal:
  ```
  [REQ] POST /api/v1/validate request_id=8ed9d65b-f6be-4e5b-af96-8031da7c4dcf
  ```
- **Reference:** The `X-Request-ID` is returned in the API response headers.

### 2. Standardized Error Responses

- **Validation Errors (422):** Returns a list of friendly error messages for user correction.
  ```json
  {
    "statusCode": 422,
    "body": {
      "statusCode": 422,
      "responseMessage": "Input Validation Failed",
      "response": ["Field 'lat': value is not a valid number"]
    }
  }
  ```
- **Internal Errors (500):** Hides sensitive details from the client but logs full tracebacks server-side.
  ```json
  {
    "statusCode": 500,
    "body": {
      "statusCode": 500,
      "responseMessage": "Internal Server Error",
      "response": null
    }
  }
  ```

### 3. Static File Serving

- Processed files and outputs are accessible via the `/files/` endpoint.
- **Base URL:** `http://localhost:8000/files/`
- **Example:** To access a matched document PDF:
  ```
  http://localhost:8000/files/validate/{request_id}/matched_docs/2420_2022.pdf
  ```
- The `file_path` field in validation results contains the relative path from `outputs/`, which can be prepended with `/files/` to access the file directly.

 #   m a s t e r - d r i v e 
 
 
