
import sys
import os
import shutil

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import SessionLocal, engine, Base
from common.landwise_models import (
    Parcel, LandwiseDocument, Owner, OwnershipTransfer,
    Encumbrance, AnalysisResult, RiskFlag, ConsistencyCheck,
    ConsistencyMismatch, ChecklistItem, LegalOpinion, ChatMessage,
    ExtractionJob, ExtractedField, AuditLog, Project, ProjectTeamAssignment,
    DocumentAnnotation
)
from common.models import ValidationRequest, ECRecord, ValidationResult, RiskScore
from sqlalchemy import text

def wipe_data():
    db = SessionLocal()
    try:
        print("[*] Wiping database tables...")
        
        # 1. Clear all Landwise tables in order of dependency
        # Delete child tables first to avoid FK violations
        db.execute(text("DELETE FROM opinion_sections"))
        db.query(ChatMessage).delete()
        db.query(LegalOpinion).delete()
        db.query(ChecklistItem).delete()
        db.query(ConsistencyMismatch).delete()
        db.query(ConsistencyCheck).delete()
        db.query(RiskFlag).delete()
        db.query(AuditLog).delete()
        db.query(AnalysisResult).delete()
        db.query(Encumbrance).delete()
        db.query(OwnershipTransfer).delete()
        db.query(Owner).delete()
        db.query(ExtractedField).delete()
        db.query(ExtractionJob).delete()
        # User-authored PDF notes — must be deleted before LandwiseDocument /
        # Parcel because DocumentAnnotation has FKs to both.
        db.query(DocumentAnnotation).delete()
        db.query(LandwiseDocument).delete()
        db.query(ProjectTeamAssignment).delete()
        db.query(Parcel).delete()
        db.query(Project).delete()
        
        # 2. Clear legacy validation tables
        db.query(RiskScore).delete()
        db.query(ValidationResult).delete()
        db.query(ECRecord).delete()
        db.query(ValidationRequest).delete()
        
        db.commit()
        print("[+] Database tables wiped.")

        # 3. Wipe local file storage
        print("[*] Wiping local file storage...")
        folders_to_clear = [
            os.path.join("outputs", "validate"),
            os.path.join("outputs", "storage", "vault"),
            os.path.join("inputs", "validate")
        ]
        
        for folder in folders_to_clear:
            if os.path.exists(folder):
                for filename in os.listdir(folder):
                    file_path = os.path.join(folder, filename)
                    try:
                        if os.path.isfile(file_path) or os.path.islink(file_path):
                            os.unlink(file_path)
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                    except Exception as e:
                        print(f"Failed to delete {file_path}. Reason: {e}")
                print(f"[+] Cleared folder: {folder}")

        # Clear cache index
        cache_index = os.path.join("outputs", "validate_cache_index.json")
        if os.path.exists(cache_index):
            os.remove(cache_index)
            print(f"[+] Deleted cache index: {cache_index}")

        print("[!] All data wiped successfully.")
        
    except Exception as e:
        print(f"[!] Error during wipe: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    force = len(sys.argv) > 1 and sys.argv[1] in ['--yes', '-y']
    
    if force:
        print("[!] Force wipe initiated via command line flag.")
        wipe_data()
    else:
        confirm = input("Are you sure you want to WIPE ALL DATA? (y/N): ")
        if confirm.lower() == 'y':
            wipe_data()
        else:
            print("Wipe cancelled.")
