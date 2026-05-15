"""Drop conflicting tables and recreate all Landwise tables."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common.database import Base, engine
from sqlalchemy import inspect, text

insp = inspect(engine)
existing = insp.get_table_names()
print(f"Existing tables ({len(existing)}):", sorted(existing))

# Drop in reverse dependency order (only new Landwise tables, never legacy)
drop_order = [
    'opinion_sections', 'legal_opinions', 'checklist_items',
    'consistency_mismatches', 'consistency_checks', 'risk_flags',
    'encumbrances', 'ownership_transfers', 'owners',
    'document_annotations', 'extracted_fields', 'extraction_jobs',
    'external_fetch_logs', 'notifications', 'audit_logs',
    'lw_documents', 'parcels', 'project_team_assignments',
    'projects', 'users'
]

with engine.connect() as conn:
    for t in drop_order:
        if t in existing:
            conn.execute(text(f'DROP TABLE IF EXISTS "{t}" CASCADE'))
            print(f"  Dropped: {t}")
    conn.commit()

print("\nNow recreating all tables...")

# Import both model sets so Base knows about all tables
import common.models
import common.landwise_models

Base.metadata.create_all(bind=engine)

# Verify
insp2 = inspect(engine)
new_tables = sorted(insp2.get_table_names())
print(f"\nSUCCESS: {len(new_tables)} tables now exist:")
for t in new_tables:
    print(f"  ✓ {t}")
