
import sys
import os

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import SessionLocal
from common.landwise_models import User, Role, ProjectTeamAssignment

def migrate_roles():
    db = SessionLocal()
    try:
        # 1. Get the legal_advisor role
        legal_advisor_role = db.query(Role).filter(Role.name == "legal_advisor").first()
        if not legal_advisor_role:
            print("Legal Advisor role not found. Please seed roles first.")
            return

        # 2. Update users with site_manager role to legal_advisor
        users_to_update = db.query(User).filter(User.system_role == "site_manager").all()
        for user in users_to_update:
            user.role_id = legal_advisor_role.id
            user.system_role = "legal_advisor"
            print(f"Updated user: {user.email} to legal_advisor")

        # 3. Update project team assignments
        assignments_to_update = db.query(ProjectTeamAssignment).filter(ProjectTeamAssignment.role == "site_manager").all()
        for assignment in assignments_to_update:
            assignment.role = "legal_advisor"
            print(f"Updated assignment for user_id: {assignment.user_id} in project_id: {assignment.project_id} to legal_advisor")

        # 4. Remove the site_manager role from the roles table
        site_manager_role = db.query(Role).filter(Role.name == "site_manager").first()
        if site_manager_role:
            db.delete(site_manager_role)
            print("Deleted site_manager role from roles table.")

        db.commit()
        print("Migration completed successfully.")
    except Exception as e:
        print(f"Error during migration: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    migrate_roles()
