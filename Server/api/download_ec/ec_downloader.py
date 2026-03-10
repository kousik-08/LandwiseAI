import requests
import os
import base64
import urllib.parse

class ECDownloader:
    # The API and Home URLs
    API_URL = "https://tngis.tn.gov.in/apps/gi_viewer_api/api/encumbrance_certificate"
    HOME_URL = "https://tngis.tn.gov.in/apps/gi_viewer/"

    def __init__(self, output_dir: str = "outputs/EC"):
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        self.session = requests.Session()
        
        # Updated Headers: X-APP-NAME must be 'GI_VIEWER'
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/json",
            "X-APP-NAME": "GI_VIEWER",  # <--- CRITICAL FIX
            "X-Requested-With": "XMLHttpRequest",
            "Referer": self.HOME_URL,
            "Origin": "https://tngis.tn.gov.in",
        }

    def _prepare_session(self):
        """Initializes cookies and extracts the XSRF token."""
        try:
            # 1. Visit the home page to get cookies (PHPSESSID and XSRF-TOKEN)
            response = self.session.get(self.HOME_URL, headers=self.headers, timeout=20)
            
            # 2. Extract XSRF-TOKEN from cookies and add to headers
            # Laravel-based APIs (like TNGIS) require this for POST requests
            xsrf_token = self.session.cookies.get("XSRF-TOKEN")
            if xsrf_token:
                # The token in the cookie is URL-encoded; it must be decoded
                self.headers["X-XSRF-TOKEN"] = urllib.parse.unquote(xsrf_token)
                return True
        except Exception as e:
            print(f"Session prep failed: {e}")
        return False

    def download_ec(
        self,
        district_code: str,
        taluk_code: str,
        village_code: str,
        survey_no: str,
        sub_div: str = "-",
    ) -> str:
        # Ensure session is fresh and headers have the XSRF token
        self._prepare_session()

        # Formatting
        village_code = str(village_code).zfill(3)
        # If sub_div is "-", the API usually expects an empty string or "0"
        sub_div_param = "" if sub_div == "-" else sub_div

        payload = {
            "revDistrictCode": str(district_code),
            "revTalukCode": str(taluk_code),
            "revVillageCode": str(village_code),
            "survey_number": str(survey_no),
            "sub_division_number": sub_div_param,
        }

        try:
            response = self.session.post(
                self.API_URL, json=payload, headers=self.headers, timeout=45
            )
            
            # Check for the 'Invalid App key' error in the raw response
            if response.status_code == 200:
                data = response.json()
                
                # Handle the specific "Invalid App key" message
                if data.get("message") == "Invalid App key":
                    raise ValueError("The server rejected the X-APP-NAME. Ensure it is set to 'GI_VIEWER'.")

                ec_data = data.get("EC", {})
                status_code = ec_data.get("statusCode")

                if status_code == 100:
                    b64_string = ec_data.get("Base64String")
                    if b64_string:
                        # Clean base64 string if it contains data URI prefix
                        if "," in b64_string:
                            b64_string = b64_string.split(",")[1]
                        
                        pdf_bytes = base64.b64decode(b64_string)
                        filename = f"{district_code}_{taluk_code}_{village_code}_{survey_no}_{sub_div}_EC.pdf"
                        output_path = os.path.join(self.output_dir, filename)
                        
                        with open(output_path, "wb") as f:
                            f.write(pdf_bytes)
                        return os.path.abspath(output_path)
                
                raise ValueError(f"API Error: {ec_data.get('statusMessage', 'Unknown Error')} (Code: {status_code})")
            
            else:
                raise ValueError(f"HTTP Error: {response.status_code}")

        except Exception as e:
            raise RuntimeError(f"EC Download failed: {str(e)}")
