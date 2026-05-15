
import sys
import os

# Add project root to sys.path
sys.path.append(os.getcwd())

from sqlalchemy import text
from common.database import engine, SessionLocal
from common.landwise_models import (
    LandwiseDocument, ExtractionJob, DocumentAnnotation, 
    Owner, OwnershipTransfer, Encumbrance, RiskFlag, 
    ConsistencyCheck, ConsistencyMismatch, ChecklistItem, 
    LegalOpinion, AnalysisResult, ExtractedField
)

def wipe_all_data():
    db = SessionLocal()
    try:
        print("[!] GLOBAL FORENSIC WIPE INITIATED...")
        
        # 1. Delete dependent analysis results and metadata
        db.query(AnalysisResult).delete()
        db.query(ConsistencyMismatch).delete()
        db.query(ConsistencyCheck).delete()
        db.query(ChecklistItem).delete()
        db.query(RiskFlag).delete()
        db.query(OwnershipTransfer).delete()
        db.query(Encumbrance).delete()
        db.query(Owner).delete()
        db.query(LegalOpinion).delete()
        db.query(ExtractedField).delete()
        db.query(ExtractionJob).delete()
        db.query(DocumentAnnotation).delete()
        
        # 2. Delete all document records (including binary content)
        doc_count = db.query(LandwiseDocument).delete()
        
        db.commit()
        print(f"[+] Successfully wiped {doc_count} document records and all associated forensic data.")
        
        # 3. Clean physical storage for good measure
        outputs_dir = os.path.join("outputs", "validate")
        inputs_dir = os.path.join("inputs", "validate")
        
        import shutil
        if os.path.exists(outputs_dir):
            shutil.rmtree(outputs_dir)
            os.makedirs(outputs_dir, exist_ok=True)
            print("[+] Cleared outputs/validate directory.")
            
        if os.path.exists(inputs_dir):
            shutil.rmtree(inputs_dir)
            os.makedirs(inputs_dir, exist_ok=True)
            print("[+] Cleared inputs/validate directory.")

        print("[***] GLOBAL WIPE COMPLETE. System is now reset.")

    except Exception as e:
        db.rollback()
        print(f"[!] Wipe failed: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    # WARNING: This is a destructive operation.
    wipe_all_data()
