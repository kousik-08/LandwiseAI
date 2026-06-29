"""
Migration: Add missing columns to projects table and wipe all projects.
This handles the schema mismatch after adding project_type, project_icon, legal_advisor_id fields.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from sqlalchemy import text
from common.database import engine, SessionLocal
from common.landwise_models import Project, ProjectTeamAssignment, Parcel, LandwiseDocument

def migrate():
    db = SessionLocal()
    try:
        print("Wiping all projects and related data...")
        
        # Delete in order respecting foreign keys
        # 1. Delete documents first (they reference parcels)
        db.query(LandwiseDocument).delete(synchronize_session=False)
        print("  - Deleted all landwise documents")
        
        # 2. Delete parcels (they reference projects)
        db.query(Parcel).delete(synchronize_session=False)
        print("  - Deleted all parcels")
        
        # 3. Delete team assignments
        db.query(ProjectTeamAssignment).delete(synchronize_session=False)
        print("  - Deleted all project team assignments")
        
        # 4. Finally delete all projects
        db.query(Project).delete(synchronize_session=False)
        print("  - Deleted all projects")
        
        db.commit()
        print("\nAll project data wiped successfully.")
        
        # Now add missing columns to projects table
        print("\nAdding missing columns to projects table...")
        
        with engine.connect() as conn:
            # Add project_type column
            try:
                conn.execute(text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT 'Land Acquisition'"))
                print("  - Added project_type column")
            except Exception as e:
                print(f"  - project_type column may already exist: {e}")
            
            # Add project_icon column
            try:
                conn.execute(text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_icon VARCHAR(50) DEFAULT 'building'"))
                print("  - Added project_icon column")
            except Exception as e:
                print(f"  - project_icon column may already exist: {e}")
            
            # Add legal_advisor_id column
            try:
                conn.execute(text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS legal_advisor_id VARCHAR(36)"))
                print("  - Added legal_advisor_id column")
            except Exception as e:
                print(f"  - legal_advisor_id column may already exist: {e}")
            
            # Add target_acquisition_date column if missing
            try:
                conn.execute(text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_acquisition_date DATE"))
                print("  - Added target_acquisition_date column")
            except Exception as e:
                print(f"  - target_acquisition_date column may already exist: {e}")
            
            conn.commit()
        
        print("\nMigration completed successfully!")
        print("You can now restart your backend server and create new projects.")
        
    except Exception as e:
        db.rollback()
        print(f"Error during migration: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()
