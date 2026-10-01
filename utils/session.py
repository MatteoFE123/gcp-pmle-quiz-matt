import logging
import os
import pickle
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import streamlit as st
from diskcache import Cache, Timeout
from pydantic import ValidationError

from models.questions import Question
from utils import DataError, ROOT_DIR, _question_from_row, reset_progress, update_progress

CACHE_DIR = Path(os.environ.get("QUIZ_CACHE_DIR", ROOT_DIR / "cache")).resolve()
SESSION_KEY = "quiz_round_v1"
SESSION_BACKUP_KEY = "quiz_round_v1_backup"
LEGACY_BACKUP_KEY = "quiz_round_legacy_backup"
SESSION_VERSION = 1
logger = logging.getLogger(__name__)

_STATE_KEYS = (
    "quiz_in_progress",
    "quizzes",
    "quiz_mode_pos",
    "quiz_mode_round_progress",
    "quiz_mode_selections",
    "round_id",
)
_LEGACY_KEYS = ("quiz_in_progress", "quizzes", "quiz_mode_pos", "quiz_mode_round_progress")


@contextmanager
def _cache():
    try:
        storage = Cache(str(CACHE_DIR), timeout=10)
        try:
            yield storage
        finally:
            storage.close()
    except (OSError, sqlite3.Error, Timeout, pickle.PickleError, EOFError):
        logger.error("No se pudo acceder a la ronda guardada.")
        raise DataError("No se pudo acceder a la ronda guardada. Comprueba la carpeta de caché.") from None


def _empty_state():
    return {
        "quiz_in_progress": False,
        "quizzes": [],
        "quiz_mode_pos": 0,
        "quiz_mode_round_progress": {},
        "quiz_mode_selections": {},
        "round_id": "",
    }


def _invalid():
    return DataError("La ronda guardada no es válida. Se ha conservado para su recuperación.")


def _validate_state(state):
    if not isinstance(state, dict) or any(key not in state for key in _STATE_KEYS):
        raise _invalid()
    active = state["quiz_in_progress"]
    position = state["quiz_mode_pos"]
    round_id = state["round_id"]
    if type(active) is not bool or type(position) is not int or position < 0 or not isinstance(round_id, str):
        raise _invalid()
    if not isinstance(state["quizzes"], list):
        raise _invalid()
    try:
        questions = [
            Question.model_validate(q.model_dump() if isinstance(q, Question) else q)
            for q in state["quizzes"]
        ]
    except (ValidationError, ValueError, TypeError):
        raise _invalid() from None
    if len({q.id for q in questions}) != len(questions) or position > len(questions):
        raise _invalid()
    results = state["quiz_mode_round_progress"]
    selections = state["quiz_mode_selections"]
    if not isinstance(results, dict) or not isinstance(selections, dict):
        raise _invalid()
    for index, result in results.items():
        if type(index) is not int or not 0 <= index < len(questions) or type(result) is not bool:
            raise _invalid()
    for index, values in selections.items():
        if (
            type(index) is not int
            or not 0 <= index < len(questions)
            or not isinstance(values, list)
            or any(type(value) is not int or not 0 <= value < len(questions[index].options) for value in values)
            or len(set(values)) != len(values)
            or (questions[index].mode == "single_choice" and len(values) > 1)
        ):
            raise _invalid()
        if index in results:
            if not values:
                raise _invalid()
            answer = questions[index].answer
            correct = set(values) == set(answer if isinstance(answer, list) else [answer])
            if correct != results[index]:
                raise _invalid()
    if active:
        if not questions or not round_id.strip():
            raise _invalid()
    elif questions or position or results or selections or round_id:
        raise _invalid()
    return {
        "quiz_in_progress": active,
        "quizzes": questions,
        "quiz_mode_pos": position,
        "quiz_mode_round_progress": dict(results),
        "quiz_mode_selections": {key: list(value) for key, value in selections.items()},
        "round_id": round_id,
    }


def _read_record(storage):
    if SESSION_KEY in storage:
        record = storage[SESSION_KEY]
        if (
            not isinstance(record, dict)
            or type(record.get("version")) is not int
            or record["version"] != SESSION_VERSION
            or type(record.get("revision")) is not int
            or record["revision"] < 0
        ):
            raise _invalid()
        return record["revision"], _validate_state(record.get("state"))
    active = storage.get("quiz_in_progress", False)
    if active is None:
        active = False
    if type(active) is not bool:
        raise _invalid()
    if not active:
        return 0, _empty_state()
    legacy_questions = storage.get("quizzes", [])
    if not isinstance(legacy_questions, list):
        raise _invalid()
    legacy_questions = [
        _question_from_row(question, index + 1)
        for index, question in enumerate(legacy_questions)
    ]
    legacy = {
        "quiz_in_progress": True,
        "quizzes": legacy_questions,
        "quiz_mode_pos": storage.get("quiz_mode_pos", 0),
        "quiz_mode_round_progress": storage.get("quiz_mode_round_progress", {}),
        "quiz_mode_selections": {},
        "round_id": f"legacy-{uuid4().hex}",
    }
    logger.warning("Ronda heredada recuperada sin inventar selecciones de respuesta.")
    return 0, _validate_state(legacy)


def load_session():
    state = st.session_state
    if not state.get("_quiz_session_loaded", False):
        with _cache() as storage:
            with storage.transact():
                revision, restored = _read_record(storage)
        for key, value in restored.items():
            state[key] = value
        state["_quiz_session_revision"] = {"value": revision}
        state["_quiz_session_loaded"] = True
    state.setdefault("wrong_answered_inclusion", False)
    state["quiz_mode_answered"] = state.get("quiz_mode_pos", 0) in state.get("quiz_mode_round_progress", {})
    if "message" in state:
        st.info(state.pop("message"))


def _revision_holder():
    holder = st.session_state.get("_quiz_session_revision")
    if not st.session_state.get("_quiz_session_loaded"):
        raise DataError("Carga la sesión antes de guardar la ronda.")
    if type(holder) is int and holder >= 0:
        holder = {"value": holder}
        st.session_state["_quiz_session_revision"] = holder
    if not isinstance(holder, dict) or type(holder.get("value")) is not int or holder["value"] < 0:
        raise DataError("Carga la sesión antes de guardar la ronda.")
    return holder


def _store_record(storage, revision, state):
    serialized = dict(state)
    serialized["quizzes"] = [q.model_dump(mode="json") for q in state["quizzes"]]
    if SESSION_KEY not in storage and any(key in storage for key in _LEGACY_KEYS):
        storage.set(LEGACY_BACKUP_KEY, {key: storage.get(key) for key in _LEGACY_KEYS})
    if SESSION_KEY in storage:
        storage.set(SESSION_BACKUP_KEY, storage[SESSION_KEY])
    storage.set(
        SESSION_KEY,
        {"version": SESSION_VERSION, "revision": revision + 1, "state": serialized},
    )


def _commit(state):
    holder = _revision_holder()
    expected = holder["value"]
    state = _validate_state(state)
    with _cache() as storage:
        with storage.transact():
            revision, _ = _read_record(storage)
            if revision != expected:
                raise DataError("La ronda ha cambiado en otra pestaña. Recarga la sesión antes de continuar.")
            _store_record(storage, revision, state)
        # SafeSessionState access can yield to a pending rerun; acknowledge without it.
        holder["value"] = revision + 1


def cache_session():
    state = {key: st.session_state.get(key) for key in _STATE_KEYS}
    if state["quiz_in_progress"] is None:
        state["quiz_in_progress"] = False
    _commit(state)
    st.session_state["quiz_mode_answered"] = state["quiz_mode_pos"] in state["quiz_mode_round_progress"]


def clear_session_cache():
    finish_round(False)


def finish_round(save: bool) -> None:
    """Commit checkpointed results only while owning the current round revision."""
    if type(save) is not bool:
        raise DataError("Indica si deseas guardar o descartar la ronda.")
    holder = _revision_holder()
    expected = holder["value"]
    with _cache() as storage:
        with storage.transact():
            revision, state = _read_record(storage)
            if revision != expected:
                raise DataError("La ronda ha cambiado en otra pestaña. Recarga la sesión antes de continuar.")
            if save and state["quiz_in_progress"]:
                results = {
                    state["quizzes"][position].id: correct
                    for position, correct in state["quiz_mode_round_progress"].items()
                }
                update_progress(results)
            # The tombstone prevents another tab from restoring the cleared checkpoint.
            _store_record(storage, revision, _empty_state())
        holder["value"] = revision + 1


def reset_history() -> None:
    holder = _revision_holder()
    expected = holder["value"]
    with _cache() as storage:
        with storage.transact():
            revision, state = _read_record(storage)
            if revision != expected:
                raise DataError("La sesión ha cambiado en otra pestaña. Recarga antes de reiniciar el historial.")
            if state["quiz_in_progress"]:
                raise DataError("Hay una ronda activa. Guárdala o descártala antes de reiniciar el historial.")
            reset_progress()
            _store_record(storage, revision, _empty_state())
        holder["value"] = revision + 1
