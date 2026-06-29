"""
CheckResult — the single contract every checklist provider returns.

A provider answers ONE checklist item and returns a verdict the frontend can
render directly. Verdicts MUST be from the UI vocabulary used by the LegalDashboard
checklist tab (NOT the model's stale 'caution'/'fail' comment):

    clear      → green   (a real positive signal was found)
    issue      → red     (a real negative finding; keeps the phase gate CLOSED)
    escalated  → amber   (needs escalation / senior review)
    na         → grey    (not applicable for this parcel)
    pending    → slate   (honest: data/source not available to decide — NEVER faked)

'pending' is how we stay honest: when a document hasn't been uploaded or an
external source isn't connected, the provider returns pending(note) explaining
exactly what is required. It never returns a fabricated clear.
"""
from dataclasses import dataclass

UI_VERDICTS = ("pending", "clear", "issue", "escalated", "na")
DECISIVE_VERDICTS = ("clear", "issue", "escalated", "na")


@dataclass
class CheckResult:
    verdict: str
    note: str

    # ── convenience constructors ──
    @classmethod
    def clear(cls, note: str) -> "CheckResult":
        return cls("clear", note)

    @classmethod
    def issue(cls, note: str) -> "CheckResult":
        return cls("issue", note)

    @classmethod
    def escalated(cls, note: str) -> "CheckResult":
        return cls("escalated", note)

    @classmethod
    def na(cls, note: str) -> "CheckResult":
        return cls("na", note)

    @classmethod
    def pending(cls, note: str) -> "CheckResult":
        """Honest 'cannot decide yet — requires X'. Leaves the item pending."""
        return cls("pending", note)

    @property
    def is_decisive(self) -> bool:
        return self.verdict in DECISIVE_VERDICTS
