from sqlalchemy import Column, Integer, String, Float, Boolean, JSON, ForeignKey, DateTime, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base

class ValidationRequest(Base):
    __tablename__ = "validation_requests"

    id = Column(String, primary_key=True)  # request_id from uuid
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String, default="pending")  # pending, processing, completed, error
    
    # Store input info
    type = Column(String)  # local_path or files
    ec_pdf_path = Column(String, nullable=True)
    zip_path = Column(String, nullable=True)
    
    # Relationships
    ec_records = relationship("ECRecord", back_populates="request")
    validation_results = relationship("ValidationResult", back_populates="request")
    risk_score = relationship("RiskScore", back_populates="request", uselist=False)

class ECRecord(Base):
    __tablename__ = "ec_records"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(String, ForeignKey("validation_requests.id"))
    document_number = Column(String, index=True)
    date = Column(String)
    nature = Column(String)
    executant = Column(String)
    claimant = Column(String)
    survey_number = Column(String)
    area = Column(String)  # raw area string
    json_data = Column(JSON)  # full extracted JSON for flexibility

    request = relationship("ValidationRequest", back_populates="ec_records")

class ValidationResult(Base):
    __tablename__ = "validation_results"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(String, ForeignKey("validation_requests.id"))
    document_number = Column(String, index=True)
    match = Column(Boolean)
    trustability_score = Column(Float)
    reason_for_failure = Column(Text)
    comparisons = Column(JSON)
    file_path = Column(String)
    vault_path = Column(String, nullable=True)

    request = relationship("ValidationRequest", back_populates="validation_results")

class RiskScore(Base):
    __tablename__ = "risk_scores"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(String, ForeignKey("validation_requests.id"), unique=True)
    score = Column(Float)
    grade = Column(String)
    recommendation = Column(Text)
    ai_summary = Column(Text)
    factors = Column(JSON)
    metadata_json = Column(JSON)
    flags = Column(JSON)

    request = relationship("ValidationRequest", back_populates="risk_score")

class NodeNote(Base):
    __tablename__ = "node_notes"

    doc_no = Column(String, primary_key=True)
    note = Column(Text)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
