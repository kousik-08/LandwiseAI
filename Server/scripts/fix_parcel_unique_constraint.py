"""
Migration script to fix the unique constraint on parcels table to handle soft deletes.
Changes from unique constraint on (project_id, survey_number, subdivision) 
to partial unique index that only applies to is_active = TRUE parcels.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from sqlalchemy import text
from common.database import engine

def migrate():
    """Update unique constraint to partial index for soft delete support."""
    print("[*] Starting migration: Fix parcel unique constraint for soft deletes")
    
    with engine.connect() as conn:
        # 1. Drop the existing unique constraint
        try:
            conn.execute(text("""
                ALTER TABLE parcels 
                DROP CONSTRAINT IF EXISTS uq_parcel_survey
            """))
            conn.commit()
            print("  - Dropped old unique constraint 'uq_parcel_survey'")
        except Exception as e:
            print(f"  - Note: Could not drop constraint (may not exist): {e}")
        
        # 2. Drop existing partial index if it exists
        try:
            conn.execute(text("""
                DROP INDEX IF EXISTS uq_parcel_survey_active
            """))
            conn.commit()
            print("  - Dropped existing partial index if present")
        except Exception as e:
            print(f"  - Note: Could not drop index: {e}")
        
        # 3. Create new partial unique index that only applies to active parcels
        conn.execute(text("""
            CREATE UNIQUE INDEX uq_parcel_survey_active 
            ON parcels (project_id, survey_number, subdivision) 
            WHERE is_active = TRUE
        """))
        conn.commit()
        print("  - Created partial unique index 'uq_parcel_survey_active' for active parcels only")
        
        # 4. Also add a regular index for faster lookups on deleted parcels (optional)
        try:
            conn.execute(text("""
                CREATE INDEX idx_parcels_deleted_lookup 
                ON parcels (project_id, survey_number, subdivision) 
                WHERE is_active = FALSE
            """))
            conn.commit()
            print("  - Created index for deleted parcel lookups")
        except Exception as e:
            print(f"  - Note: Could not create deleted lookup index: {e}")
        
    print("[+] Migration completed successfully!")
    print("")
    print("Summary:")
    print("- Unique constraint now only applies to ACTIVE parcels (is_active = TRUE)")
    print("- Soft-deleted parcels can have duplicate survey numbers")
    print("- Creating a parcel with a previously deleted survey number will restore it")

if __name__ == "__main__":
    migrate()
