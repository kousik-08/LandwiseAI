"""
LandwiseAI 3.0 — Complete Database Schema
==========================================
20 tables for the Legal Advisor E2E workflow.
These models coexist with the legacy models in models.py.
Both share the same Base and PostgreSQL database.

Tables are auto-created on startup via Base.metadata.create_all(engine).
"""

import uuid
from sqlalchemy import (
    Column, String, Text, Boolean, Integer, SmallInteger,
    Float, Date, DateTime, ForeignKey, Numeric, BigInteger,
    Index, UniqueConstraint, CheckConstraint, Enum, LargeBinary
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base


# ── Helper ──
def gen_uuid():
    return str(uuid.uuid4())


# ══════════════════════════════════════════════════════════════
#  TABLE 0: roles (Lookup Table)
# ══════════════════════════════════════════════════════════════
class Role(Base):
    __tablename__ = "roles"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String(50), unique=True, nullable=False)  # super_admin, portfolio_manager, legal_advisor
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    users = relationship("User", back_populates="role_obj")


# ══════════════════════════════════════════════════════════════
#  TABLE 1: users
# ══════════════════════════════════════════════════════════════
class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=gen_uuid)
    full_name = Column(String(255), nullable=False)
    email = Column(String(320), unique=True, nullable=False)
    phone = Column(String(20), nullable=True)
    password_hash = Column(String(255), nullable=True)
    role_id = Column(String, ForeignKey("roles.id"), nullable=True)
    system_role = Column(
        String(50), nullable=True
    )  # Keep for backwards compatibility/migration
    bar_council_id = Column(String(100), nullable=True)
    digital_signature_cert = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    role_obj = relationship("Role", back_populates="users")


# ══════════════════════════════════════════════════════════════
#  TABLE 2: projects
# ══════════════════════════════════════════════════════════════
class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    project_type = Column(String(100), nullable=True)  # Land Acquisition, Title Diligence, etc.
    project_icon = Column(String(50), nullable=True)   # Icon name/identifier
    state = Column(String(100), nullable=False, default='Tamil Nadu')
    district = Column(String(100), nullable=False, default='Unknown')
    status = Column(
        String(20), nullable=False, default='active'
    )  # active, archived, suspended
    target_acquisition_date = Column(Date, nullable=True)
    legal_advisor_id = Column(String, ForeignKey("users.id"), nullable=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    parcels = relationship("Parcel", back_populates="project", lazy="dynamic")
    team_assignments = relationship("ProjectTeamAssignment", back_populates="project")


# ══════════════════════════════════════════════════════════════
#  TABLE 3: project_team_assignments
# ══════════════════════════════════════════════════════════════
class ProjectTeamAssignment(Base):
    __tablename__ = "project_team_assignments"

    id = Column(String, primary_key=True, default=gen_uuid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(
        String(50), nullable=False
    )  # legal_advisor, portfolio_manager
    assigned_by = Column(String, ForeignKey("users.id"), nullable=True)
    assigned_at = Column(DateTime(timezone=True), server_default=func.now())
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint('project_id', 'user_id', 'role', name='uq_project_user_role'),
    )

    project = relationship("Project", back_populates="team_assignments")


# ══════════════════════════════════════════════════════════════
#  TABLE 4: parcels
# ══════════════════════════════════════════════════════════════
class Parcel(Base):
    __tablename__ = "parcels"

    id = Column(String, primary_key=True, default=gen_uuid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    survey_number = Column(String(50), nullable=False)
    subdivision = Column(String(50), nullable=True)
    district = Column(String(100), nullable=False, default='Unknown')
    taluk = Column(String(100), nullable=False, default='Unknown')
    village = Column(String(100), nullable=False, default='Unknown')
    area_acres = Column(Numeric(10, 4), nullable=True)
    area_sqft = Column(Numeric(12, 2), nullable=True)
    land_use_type = Column(String(100), nullable=True)  # Dry, Wet, Waste
    status = Column(
        String(20), nullable=False, default='pending'
    )  # pending, in_review, flagged, verified, completed
    risk_score = Column(SmallInteger, default=0)
    completion_score = Column(SmallInteger, default=0)
    document_completeness_pct = Column(SmallInteger, default=0)

    # New fields for document validation tracking
    total_docs_count = Column(Integer, default=0)
    passed_docs_count = Column(Integer, default=0)
    avg_trustability_score = Column(Numeric(5, 2), default=0)
    scrutiny_docs_count = Column(Integer, default=0)

    # Full risk-score result cache (factors, AI summary, document_details,
    # gap_details, flags, etc.). Populated on first compute; subsequent
    # GETs read this directly to avoid re-running the LLM. Cleared by the
    # validation pipeline whenever a fresh audit is started for the parcel.
    risk_score_data = Column(JSONB, nullable=True)
    risk_score_computed_at = Column(DateTime(timezone=True), nullable=True)
    
    assigned_lawyer_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Boolean, default=True)  # Soft delete flag - False means deleted/hidden

    # Bridge to legacy system
    legacy_request_id = Column(String, nullable=True)
    last_analysis_request_id = Column(String, nullable=True)

    # Note: Unique constraint is handled by partial index in migration
    # uq_parcel_survey_active index enforces uniqueness only for is_active = TRUE
    # This allows soft-deleted parcels to have duplicate survey numbers

    # Relationships
    project = relationship("Project", back_populates="parcels")
    documents = relationship("LandwiseDocument", back_populates="parcel", lazy="dynamic")
    annotations = relationship("DocumentAnnotation", back_populates="parcel")
    owners = relationship("Owner", back_populates="parcel")
    transfers = relationship("OwnershipTransfer", back_populates="parcel")
    encumbrances = relationship("Encumbrance", back_populates="parcel")
    risk_flags = relationship("RiskFlag", back_populates="parcel")
    checklist_items = relationship("ChecklistItem", back_populates="parcel")
    legal_opinion = relationship("LegalOpinion", back_populates="parcel", uselist=False)
    consistency_checks = relationship("ConsistencyCheck", back_populates="parcel")


# ══════════════════════════════════════════════════════════════
#  TABLE 5: documents (named LandwiseDocument to avoid conflict)
# ══════════════════════════════════════════════════════════════
class LandwiseDocument(Base):
    __tablename__ = "lw_documents"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    document_type = Column(
        String(30), nullable=False
    )  # EC, PATTA, SALE_DEED, GIFT_DEED, POA, WILL, PARTITION_DEED, COURT_ORDER, SURVEY_SKETCH, BUILDING_PLAN, NOC, MISC
    source = Column(
        String(30), nullable=False, default='uploaded'
    )  # uploaded, ec_registry_api, revenue_dept_api, manual_entry
    original_filename = Column(String(500), nullable=False)
    storage_key = Column(String(1000), nullable=False)  # local path or S3 key
    storage_backend = Column(String(10), nullable=True, default='local')  # 'local' | 's3'
    file_content = Column(LargeBinary, nullable=True) # Actual PDF binary stored in DB
    mime_type = Column(String(100), nullable=False, default='application/pdf')
    file_size_bytes = Column(BigInteger, nullable=True)
    page_count = Column(SmallInteger, nullable=True)
    year_from = Column(SmallInteger, nullable=True)
    year_to = Column(SmallInteger, nullable=True)
    language = Column(String(20), default='tamil')  # tamil, english, bilingual
    extraction_status = Column(
        String(20), default='pending'
    )  # pending, processing, completed, failed, skipped
    extraction_confidence = Column(Numeric(5, 2), nullable=True)
    checksum_sha256 = Column(String(64), nullable=True)
    uploaded_by = Column(String, ForeignKey("users.id"), nullable=True)
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    parcel = relationship("Parcel", back_populates="documents")
    extracted_fields = relationship("ExtractedField", back_populates="document")
    extraction_jobs = relationship("ExtractionJob", back_populates="document")
    annotations = relationship("DocumentAnnotation", back_populates="document")


# ══════════════════════════════════════════════════════════════
#  TABLE 6: extracted_fields
# ══════════════════════════════════════════════════════════════
class ExtractedField(Base):
    __tablename__ = "extracted_fields"

    id = Column(String, primary_key=True, default=gen_uuid)
    document_id = Column(String, ForeignKey("lw_documents.id"), nullable=False, index=True)
    field_key = Column(String(100), nullable=False)
    raw_value = Column(Text, nullable=True)
    normalised_value = Column(JSONB, nullable=True)
    confidence = Column(Numeric(5, 2), nullable=True)
    page_number = Column(SmallInteger, nullable=True)
    bounding_box = Column(JSONB, nullable=True)
    is_overridden = Column(Boolean, default=False)
    overridden_value = Column(Text, nullable=True)
    overridden_by = Column(String, ForeignKey("users.id"), nullable=True)
    overridden_at = Column(DateTime(timezone=True), nullable=True)
    extraction_job_id = Column(String, ForeignKey("extraction_jobs.id"), nullable=True)

    document = relationship("LandwiseDocument", back_populates="extracted_fields")


# ══════════════════════════════════════════════════════════════
#  TABLE 7: extraction_jobs
# ══════════════════════════════════════════════════════════════
class ExtractionJob(Base):
    __tablename__ = "extraction_jobs"

    id = Column(String, primary_key=True, default=gen_uuid)
    document_id = Column(String, ForeignKey("lw_documents.id"), nullable=False, index=True)
    status = Column(
        String(20), nullable=False, default='queued'
    )  # queued, running, completed, failed
    model_version = Column(String(50), nullable=False, default='gemini-2.5-flash')
    ocr_engine = Column(String(50), nullable=False, default='gemini-vision')
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    error_message = Column(Text, nullable=True)
    triggered_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("LandwiseDocument", back_populates="extraction_jobs")


# ══════════════════════════════════════════════════════════════
#  TABLE 8: document_annotations
# ══════════════════════════════════════════════════════════════
class DocumentAnnotation(Base):
    __tablename__ = "document_annotations"

    id = Column(String, primary_key=True, default=gen_uuid)
    document_id = Column(String, ForeignKey("lw_documents.id"), nullable=False, index=True)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    annotation_type = Column(
        String(20), nullable=False
    )  # risk, query, verified, condition, note
    selected_text = Column(Text, nullable=False, default='')
    note = Column(Text, nullable=True)
    page_number = Column(SmallInteger, nullable=False, default=1)
    bounding_box = Column(JSONB, nullable=True)
    is_resolved = Column(Boolean, default=False)
    resolved_by = Column(String, ForeignKey("users.id"), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    document = relationship("LandwiseDocument", back_populates="annotations")
    parcel = relationship("Parcel", back_populates="annotations")


# ══════════════════════════════════════════════════════════════
#  TABLE 9: owners
# ══════════════════════════════════════════════════════════════
class Owner(Base):
    __tablename__ = "owners"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    owner_type = Column(
        String(20), nullable=False, default='individual'
    )  # individual, huf, company, trust, government
    share_percentage = Column(Numeric(6, 3), nullable=True)
    is_nri = Column(Boolean, default=False)
    pan_number = Column(String(10), nullable=True)
    aadhaar_last4 = Column(String(4), nullable=True)
    is_current_owner = Column(Boolean, default=True)
    source_document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel", back_populates="owners")


# ══════════════════════════════════════════════════════════════
#  TABLE 10: ownership_transfers
# ══════════════════════════════════════════════════════════════
class OwnershipTransfer(Base):
    __tablename__ = "ownership_transfers"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    transfer_type = Column(
        String(30), nullable=False
    )  # sale, gift, inheritance, partition, court_order, government_acquisition
    from_owner_id = Column(String, ForeignKey("owners.id"), nullable=True)
    to_owner_id = Column(String, ForeignKey("owners.id"), nullable=True)
    transfer_date = Column(Date, nullable=True)
    registration_date = Column(Date, nullable=True)
    registration_number = Column(String(100), nullable=True)
    sub_registrar_office = Column(String(200), nullable=True)
    consideration_amount = Column(Numeric(15, 2), nullable=True)
    source_document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel", back_populates="transfers")


# ══════════════════════════════════════════════════════════════
#  TABLE 11: encumbrances
# ══════════════════════════════════════════════════════════════
class Encumbrance(Base):
    __tablename__ = "encumbrances"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    encumbrance_type = Column(
        String(30), nullable=False
    )  # mortgage, lien, easement, attachment, court_order, government_acquisition, lease
    holder_name = Column(String(255), nullable=False)
    amount = Column(Numeric(15, 2), nullable=True)
    created_date = Column(Date, nullable=True)
    status = Column(
        String(20), nullable=False, default='active'
    )  # active, discharged, disputed, partial
    discharge_date = Column(Date, nullable=True)
    noc_status = Column(
        String(20), default='not_requested'
    )  # not_requested, requested, received, rejected
    noc_received_at = Column(DateTime(timezone=True), nullable=True)
    source_document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel", back_populates="encumbrances")


# ══════════════════════════════════════════════════════════════
#  TABLE 12: risk_flags
# ══════════════════════════════════════════════════════════════
class RiskFlag(Base):
    __tablename__ = "risk_flags"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True)
    risk_category = Column(
        String(30), nullable=False
    )  # title_defect, encumbrance, litigation, missing_document, compliance,
       # ownership_dispute, area_mismatch, forgery_suspected, nri_poa, environmental
    severity = Column(
        String(10), nullable=False, default='medium'
    )  # low, medium, high, critical
    source = Column(
        String(20), nullable=False, default='ai_auto'
    )  # ai_auto, lawyer_manual, external_api
    description = Column(Text, nullable=False)
    affected_clause = Column(Text, nullable=True)
    action = Column(
        String(20), default='pending'
    )  # pending, accepted, dismissed, escalated
    action_note = Column(Text, nullable=True)
    escalated_to = Column(String, ForeignKey("users.id"), nullable=True)
    escalated_at = Column(DateTime(timezone=True), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel", back_populates="risk_flags")


# ══════════════════════════════════════════════════════════════
#  TABLE 13: consistency_checks
# ══════════════════════════════════════════════════════════════
class ConsistencyCheck(Base):
    __tablename__ = "consistency_checks"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    status = Column(
        String(20), nullable=False, default='pending'
    )  # pending, running, completed, failed
    total_fields_checked = Column(Integer, default=0)
    mismatch_count = Column(Integer, default=0)
    triggered_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    parcel = relationship("Parcel", back_populates="consistency_checks")
    mismatches = relationship("ConsistencyMismatch", back_populates="check")


# ══════════════════════════════════════════════════════════════
#  TABLE 14: consistency_mismatches
# ══════════════════════════════════════════════════════════════
class ConsistencyMismatch(Base):
    __tablename__ = "consistency_mismatches"

    id = Column(String, primary_key=True, default=gen_uuid)
    check_id = Column(String, ForeignKey("consistency_checks.id"), nullable=False, index=True)
    field_key = Column(String(100), nullable=False)
    doc_a_id = Column(String, ForeignKey("lw_documents.id"), nullable=False)
    doc_a_value = Column(Text, nullable=False)
    doc_b_id = Column(String, ForeignKey("lw_documents.id"), nullable=False)
    doc_b_value = Column(Text, nullable=False)
    severity = Column(String(10), nullable=False, default='warning')  # warning, error
    lawyer_action = Column(String(20), default='pending')  # pending, acceptable, queried
    lawyer_note = Column(Text, nullable=True)

    check = relationship("ConsistencyCheck", back_populates="mismatches")


# ══════════════════════════════════════════════════════════════
#  TABLE 15: checklist_items
# ══════════════════════════════════════════════════════════════
class ChecklistItem(Base):
    __tablename__ = "checklist_items"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    phase = Column(
        String(20), nullable=False
    )  # documents, ownership, encumbrances, compliance, final_review
    item_code = Column(String(50), nullable=False)
    item_label = Column(String(500), nullable=False)
    is_mandatory = Column(Boolean, default=True)
    verdict = Column(
        String(10), default='pending'
    )  # pending, clear, caution, fail, na
    lawyer_notes = Column(Text, nullable=True)
    verified_by = Column(String, ForeignKey("users.id"), nullable=True)
    verified_at = Column(DateTime(timezone=True), nullable=True)
    auto_populated_from = Column(String, ForeignKey("extracted_fields.id"), nullable=True)

    parcel = relationship("Parcel", back_populates="checklist_items")


# ══════════════════════════════════════════════════════════════
#  TABLE 16: legal_opinions
# ══════════════════════════════════════════════════════════════
class LegalOpinion(Base):
    __tablename__ = "legal_opinions"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, unique=True)
    status = Column(
        String(20), nullable=False, default='draft'
    )  # draft, in_review, signed, revoked
    verdict = Column(
        String(30), nullable=True
    )  # safe_to_proceed, proceed_with_caution, do_not_proceed
    drafted_by = Column(String, ForeignKey("users.id"), nullable=True)
    signed_by = Column(String, ForeignKey("users.id"), nullable=True)
    signed_at = Column(DateTime(timezone=True), nullable=True)
    digital_signature_hash = Column(Text, nullable=True)
    pdf_storage_key = Column(String(1000), nullable=True)
    storage_backend = Column(String(10), nullable=True, default='local')  # 'local' | 's3'
    is_locked = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    parcel = relationship("Parcel", back_populates="legal_opinion")
    sections = relationship("OpinionSection", back_populates="opinion")


# ══════════════════════════════════════════════════════════════
#  TABLE 17: opinion_sections
# ══════════════════════════════════════════════════════════════
class OpinionSection(Base):
    __tablename__ = "opinion_sections"

    id = Column(String, primary_key=True, default=gen_uuid)
    opinion_id = Column(String, ForeignKey("legal_opinions.id"), nullable=False, index=True)
    section_order = Column(SmallInteger, nullable=False)
    section_type = Column(
        String(50), nullable=False
    )  # possession_revenue, land_nature, tn_land_reforms, title_flow_ec, legal_protections, acquisitions_notices, lis_pendens, documents_checklist, final_verdict
    ai_draft_content = Column(Text, nullable=True)
    final_content = Column(Text, nullable=False, default='')
    is_accepted = Column(Boolean, default=False)
    accepted_at = Column(DateTime(timezone=True), nullable=True)

    opinion = relationship("LegalOpinion", back_populates="sections")


# ══════════════════════════════════════════════════════════════
#  TABLE 18: audit_logs (APPEND-ONLY)
# ══════════════════════════════════════════════════════════════
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=True, index=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=True, index=True)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(String, nullable=False)
    action = Column(String(100), nullable=False)
    actor_id = Column(String, ForeignKey("users.id"), nullable=True)
    actor_ip = Column(String(45), nullable=True)
    change_delta = Column(JSONB, nullable=True)
    metadata_json = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ══════════════════════════════════════════════════════════════
#  TABLE 19: notifications
# ══════════════════════════════════════════════════════════════
class Notification(Base):
    __tablename__ = "notifications"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    type = Column(String(100), nullable=False)
    title = Column(String(255), nullable=False)
    body = Column(Text, nullable=True)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=True)
    entity_type = Column(String(50), nullable=True)
    entity_id = Column(String, nullable=True)
    is_read = Column(Boolean, default=False)
    read_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ══════════════════════════════════════════════════════════════
#  TABLE 20: external_fetch_logs
# ══════════════════════════════════════════════════════════════
class ExternalFetchLog(Base):
    __tablename__ = "external_fetch_logs"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    source_system = Column(
        String(30), nullable=False
    )  # tn_revenue_dept, ec_registry, ecourts, bank_api, env_constraint_db
    fetch_type = Column(String(100), nullable=False)
    request_payload = Column(JSONB, nullable=True)
    http_status = Column(SmallInteger, nullable=True)
    status = Column(
        String(20), nullable=False, default='pending'
    )  # pending, success, failed, timeout, rate_limited
    response_document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True)
    error_message = Column(Text, nullable=True)
    triggered_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)


# ══════════════════════════════════════════════════════════════
#  TABLE 21: analysis_results (Stores full pipeline output JSONB)
# ══════════════════════════════════════════════════════════════
class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id = Column(String, primary_key=True, default=gen_uuid)
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=False, index=True)
    request_id = Column(String, nullable=False, index=True)
    result_type = Column(
        String(30), nullable=False
    )  # hierarchy_tree, ec_final, validation_results, mermaid_code
    status = Column(String(20), nullable=False, default="completed")  # pending, processing, completed, failed
    data = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel")


# ══════════════════════════════════════════════════════════════
#  TABLE 22: chat_messages
# ══════════════════════════════════════════════════════════════
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(String, primary_key=True, default=gen_uuid)
    document_id = Column(String, ForeignKey("lw_documents.id"), nullable=True, index=True)
    doc_no = Column(String(100), nullable=True) # Fallback for deeds not in lw_documents yet
    parcel_id = Column(String, ForeignKey("parcels.id"), nullable=True, index=True)
    role = Column(String(20), nullable=False) # user, assistant
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parcel = relationship("Parcel")

