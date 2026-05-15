"""
Migration script to add is_active column to parcels table for soft delete support.
Run this after updating the Parcel model.
"""
import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from sqlalchemy import text
from common.database import engine

def migrate():
    """Add is_active column to parcels table."""
    print("[*] Starting migration: Add is_active column to parcels table")
    
    with engine.connect() as conn:
        # Check if column already exists
        result = conn.execute(text("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'parcels' AND column_name = 'is_active'
        """))
        
        if result.fetchone():
            print("  - Column 'is_active' already exists, skipping")
        else:
            # Add the is_active column
            conn.execute(text("""
                ALTER TABLE parcels 
                ADD COLUMN is_active BOOLEAN DEFAULT TRUE
            """))
            conn.commit()
            print("  - Added 'is_active' column with default TRUE")
        
        # Update existing records to set is_active = TRUE where deleted_at is NULL
        conn.execute(text("""
            UPDATE parcels 
            SET is_active = TRUE 
            WHERE deleted_at IS NULL AND (is_active IS NULL OR is_active = FALSE)
        """))
        conn.commit()
        print("  - Updated existing active parcels")
        
        # Update records with deleted_at to have is_active = FALSE
        conn.execute(text("""
            UPDATE parcels 
            SET is_active = FALSE 
            WHERE deleted_at IS NOT NULL
        """))
        conn.commit()
        print("  - Updated deleted parcels to is_active = FALSE")
        
    print("[+] Migration completed successfully!")

if __name__ == "__main__":
    migrate()
