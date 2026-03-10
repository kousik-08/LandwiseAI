from pydantic import BaseModel, Field, field_validator
import requests
from fastapi import HTTPException, Request
import json
import time


class ReginetRequest(BaseModel):
    """
    Pydantic model for validating input.
    """

    lat: float = Field(..., description="Latitude coordinate")
    lng: float = Field(..., description="Longitude coordinate")

    @field_validator("lat", mode="before")
    @classmethod
    def validate_lat(cls, v):
        """Validate latitude is a valid number"""
        if v is None:
            raise ValueError("lat is required")
        try:
            v = float(v)
            if not -90 <= v <= 90:
                raise ValueError("lat must be between -90 and 90")
            return v
        except (ValueError, TypeError):
            raise ValueError("lat must be a valid number")

    @field_validator("lng", mode="before")
    @classmethod
    def validate_lng(cls, v):
        """Validate longitude is a valid number"""
        if v is None:
            raise ValueError("lng is required")
        try:
            v = float(v)
            if not -180 <= v <= 180:
                raise ValueError("lng must be between -180 and 180")
            return v
        except (ValueError, TypeError):
            raise ValueError("lng must be a valid number")


class LandInfoService:
    def get_land_info(self, request: Request, data: ReginetRequest) -> dict:
        """
        Fetches land info from the external API based on coordinates.
        """
        import os

        logger = request.state.logger
        start_time = time.time()
        logger.log_request(data.model_dump())

        url = os.getenv(
            "TNGIS_LANDINFO_API_URL",
            "https://tngis.tn.gov.in/apps/thematic_viewer_api/v1/getfeatureInfo",
        )
        payload = {
            "latitude": data.lat,
            "longitude": data.lng,
            "layer_name": "Thematic_XYZ",
        }

        headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "X-App-Id": "te$t",
        }

        try:
            response = requests.post(url, data=payload, headers=headers, timeout=30)
            response.raise_for_status()
            try:
                response_data = response.json()
            except json.JSONDecodeError:
                # If valid JSON isn't returned, we can't verify the fields
                raise HTTPException(
                    status_code=502, detail="Invalid JSON response from TNGIS API"
                )
            if isinstance(response_data, dict):
                reginet_success = response_data.get("success")
                reginet_message = response_data.get("message", "")
                res_body = response_data.get("data")
                if len(res_body) > 0:
                    res_body = res_body[0]
                else:
                    raise HTTPException(
                        status_code=404, detail="No Data Found: " + reginet_message
                    )
                if reginet_success == 1:
                    output = {
                        "district_code": res_body.get("district_code"),
                        "dname": res_body.get("dname"),
                        "taluk_code": res_body.get("taluk_code"),
                        "tname": res_body.get("tname"),
                        "lgd_village_code": res_body.get("lgd_village_code"),
                        "village_code": res_body.get("village_code"),
                        "vname": res_body.get("vname"),
                        "kide": res_body.get("kide"),
                        "survey_number": res_body.get("survey_number"),
                        "sub_division": res_body.get("sub_division"),
                        "request_id": request.state.request_id,
                    }

                    duration = (time.time() - start_time) * 1000
                    logger.log_output(duration_ms=duration, success=True, data=output)

                    return output

                elif reginet_success == 2:
                    # No data found
                    raise HTTPException(
                        status_code=404, detail=f"No Data Found: {reginet_message}"
                    )

                else:
                    # Other codes
                    raise HTTPException(
                        status_code=500,
                        detail=f"Unexpected success code: {reginet_success}, message: {reginet_message}",
                    )
            else:
                raise HTTPException(
                    status_code=502,
                    detail="Unexpected response format (not a valid dictionary)",
                )

        except requests.RequestException as e:
            duration = (time.time() - start_time) * 1000
            logger.log_error(str(e))
            logger.log_output(duration_ms=duration, success=False)
            raise HTTPException(status_code=500, detail=str(e))
        except HTTPException as e:
            duration = (time.time() - start_time) * 1000
            logger.log_error(str(e.detail))
            logger.log_output(duration_ms=duration, success=False)
            raise e
        except Exception as e:
            duration = (time.time() - start_time) * 1000
            logger.log_error(str(e))
            logger.log_output(duration_ms=duration, success=False)
            raise HTTPException(status_code=500, detail=str(e))


def handle_get_land_info(request: Request, body: ReginetRequest):
    service = LandInfoService()
    return service.get_land_info(request, body)
