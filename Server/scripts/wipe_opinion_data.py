
import sys
import os

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import SessionLocal
from common.landwise_models import LegalOpinion, OpinionSection
from sqlalchemy import text

def wipe_opinion_data():
    db = SessionLocal()
    try:
        print("[*] Wiping opinion data only...")
        
        # Delete child table first, then parent
        db.execute(text("DELETE FROM opinion_sections"))
        db.execute(text("DELETE FROM legal_opinions"))
        
        db.commit()
        print("[+] Opinion data wiped successfully.")
        print("   - Deleted from: opinion_sections")
        print("   - Deleted from: legal_opinions")
        print("\n[!] Parcel data, documents, and analysis results are preserved.")
        print("    You can now re-initialize the AI Legal Opinion for any parcel.")
        
    except Exception as e:
        print(f"[!] Error during opinion data wipe: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    confirm = input("Are you sure you want to WIPE ONLY OPINION DATA? (y/N): ")
    if confirm.lower() == 'y':
        wipe_opinion_data()
    else:
        print("Wipe cancelled.")
