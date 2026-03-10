from fastapi import Request, HTTPException
from api.download_ec.ec_downloader import ECDownloader
from pydantic import BaseModel
import time


class ECRequest(BaseModel):
    district_code: str
    taluk_code: str
    village_code: str
    survey_no: str
    sub_div: str = "-"


def handle_download_ec(request: Request, body: ECRequest):
    """
    Handles EC download workflow with logging.
    """
    logger = request.state.logger
    start_time = time.time()

    # Log incoming request
    logger.log_request(body.model_dump())

    downloader = ECDownloader()
    try:
        pdf_path = downloader.download_ec(
            district_code=body.district_code,
            taluk_code=body.taluk_code,
            village_code=body.village_code,
            survey_no=body.survey_no,
            sub_div=body.sub_div,
        )

        response_data = {
            "status": "success",
            "pdf_path": pdf_path,
            "message": "EC downloaded successfully",
            "request_id": request.state.request_id,
        }

        duration = (time.time() - start_time) * 1000
        logger.log_output(duration_ms=duration, success=True, data=response_data)

        return response_data

    except Exception as e:
        duration = (time.time() - start_time) * 1000
        logger.log_error(str(e))
        logger.log_output(duration_ms=duration, success=False)
        raise HTTPException(status_code=500, detail=str(e))
