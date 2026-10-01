import json
import logging
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import streamlit as st
from pydantic import ValidationError

from models.questions import Question

ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("QUIZ_DATA_DIR", ROOT_DIR / "data")).resolve()
QUIZ_FILE = DATA_DIR / "quizzes.jsonl"
PROGRESS_FILE = DATA_DIR / "progress.json"

logger = logging.getLogger(__name__)
_thread_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


class DataError(Exception):
    """Error recuperable de validación, acceso o conflicto de datos."""


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Clave JSON repetida.")
        result[key] = value
    return result


def _read_json(text):
    def invalid_constant(_):
        raise ValueError("Número JSON no válido.")

    return json.loads(text, object_pairs_hook=_json_object, parse_constant=invalid_constant)


@contextmanager
def _locked(path: Path):
    """Serialize an entire read/compare/write transaction across threads and processes."""
    key = str(path.resolve())
    with _locks_guard:
        lock = _thread_locks.setdefault(key, threading.RLock())
    with lock:
        handle = None
        acquired = False
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = path.with_name(path.name + ".lock").open("a+b")
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + 10
            while True:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise DataError("Los datos están ocupados. Vuelve a intentarlo.") from None
                    time.sleep(0.05)
            yield
        except OSError:
            logger.error("No se pudo acceder al almacenamiento: %s", path.name)
            raise DataError("No se pudo acceder a los datos. Comprueba los permisos y vuelve a intentarlo.") from None
        finally:
            if handle is not None:
                if acquired:
                    try:
                        handle.seek(0)
                        if os.name == "nt":
                            import msvcrt

                            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                    except OSError:
                        logger.error("No se pudo liberar el bloqueo: %s", path.name)
                handle.close()


def _replace_bytes(path: Path, content: bytes):
    pending = path.with_name(f".{path.name}.{uuid4().hex}.pending")
    try:
        with pending.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def _atomic_write(path: Path, content: bytes):
    if path.exists():
        _replace_bytes(path.with_name(path.name + ".bak"), path.read_bytes())
    _replace_bytes(path, content)


def _question_from_row(row, line: int) -> Question:
    # The existing bank contains one legacy scalar multiple-choice answer.
    if isinstance(row, dict) and row.get("mode") == "multiple_choice" and type(row.get("answer")) is int:
        row = dict(row)
        row["answer"] = [row["answer"]]
        logger.warning("Respuesta múltiple heredada normalizada en memoria; línea %s.", line)
    try:
        return Question.model_validate(row)
    except (ValidationError, TypeError, ValueError):
        logger.error("Pregunta no válida en la línea %s.", line)
        raise DataError(f"La pregunta de la línea {line} no es válida. Revisa sus campos y respuestas.") from None


def _catalog():
    try:
        raw_lines = QUIZ_FILE.read_bytes().splitlines(keepends=True)
    except FileNotFoundError:
        raise DataError("No se encuentra el banco de preguntas (quizzes.jsonl).") from None
    except OSError:
        raise DataError("No se puede leer el banco de preguntas. Comprueba los permisos.") from None
    questions = []
    locations = {}
    for index, raw in enumerate(raw_lines):
        if not raw.strip():
            continue
        try:
            row = _read_json(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            logger.error("JSON no válido en la línea %s del banco.", index + 1)
            raise DataError(f"El banco contiene JSON no válido en la línea {index + 1}.") from None
        question = _question_from_row(row, index + 1)
        if question.id in locations:
            raise DataError(f"El banco contiene un identificador repetido en la línea {index + 1}.")
        locations[question.id] = index
        questions.append(question)
    if not questions:
        raise DataError("El banco de preguntas está vacío. Añade preguntas válidas antes de continuar.")
    return questions, raw_lines, locations


def load_questions() -> list[Question]:
    return _catalog()[0]


def load_quizzes(progress: dict[int, bool]) -> tuple[list[Question], list[Question], list[Question]]:
    progress = _validate_progress(progress)
    incorrect, unanswered, correct = [], [], []
    for question in load_questions():
        if question.id not in progress:
            unanswered.append(question)
        elif progress[question.id]:
            correct.append(question)
        else:
            incorrect.append(question)
    return incorrect, unanswered, correct


def _validate_progress(progress) -> dict[int, bool]:
    if not isinstance(progress, dict):
        raise DataError("El progreso debe contener identificadores y resultados booleanos.")
    validated = {}
    for key, value in progress.items():
        if type(key) is int:
            question_id = key
        elif isinstance(key, str) and key.isascii() and key.isdecimal():
            try:
                question_id = int(key)
            except ValueError:
                raise DataError("El progreso contiene un identificador no válido.") from None
            if str(question_id) != key:
                raise DataError("El progreso contiene un identificador no válido.")
        else:
            raise DataError("El progreso contiene un identificador no válido.")
        if question_id <= 0 or type(value) is not bool or question_id in validated:
            raise DataError("El progreso contiene identificadores o resultados no válidos.")
        validated[question_id] = value
    return validated


def load_progress() -> dict[int, bool]:
    try:
        text = PROGRESS_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError:
        raise DataError("No se puede leer el progreso. Comprueba los permisos.") from None
    except UnicodeError:
        raise DataError("El progreso no tiene una codificación válida. Se ha conservado sin cambios.") from None
    try:
        return _validate_progress(_read_json(text))
    except (ValueError, UnicodeError, DataError):
        logger.error("El archivo de progreso no es válido; no se sobrescribirá.")
        raise DataError(
            "El progreso no es válido y se ha conservado. Recupera una copia válida antes de guardar o reiniciar."
        ) from None


def _write_progress(progress):
    _atomic_write(PROGRESS_FILE, json.dumps(progress, ensure_ascii=False, indent=2).encode("utf-8"))


def save_progress(progress):
    validated = _validate_progress(progress)
    with _locked(PROGRESS_FILE):
        load_progress()
        _write_progress(validated)


def update_progress(updates) -> dict[int, bool]:
    validated = _validate_progress(updates)
    with _locked(PROGRESS_FILE):
        progress = load_progress()
        progress.update(validated)
        _write_progress(progress)
    return progress


def reset_progress():
    save_progress({})


def save_question(question: Question, original: Question):
    try:
        question = Question.model_validate(question.model_dump())
        original = Question.model_validate(original.model_dump())
        proposed_row = question.model_dump(mode="json")
        original_row = original.model_dump(mode="json")
        json.dumps(proposed_row, allow_nan=False)
    except (ValidationError, AttributeError, TypeError, ValueError):
        raise DataError("No se puede guardar una pregunta no válida.") from None
    if question.id != original.id:
        raise DataError("No se puede cambiar el identificador de una pregunta.")
    with _locked(QUIZ_FILE):
        questions, raw_lines, locations = _catalog()
        stored = next((item for item in questions if item.id == original.id), None)
        if stored is None or stored.model_dump(mode="json") != original_row:
            raise DataError("La pregunta ha cambiado en otra sesión. Recarga antes de guardar.")
        index = locations[question.id]
        row = stored.model_dump(mode="json")
        row.update(proposed_row)
        ending = b"\r\n" if raw_lines[index].endswith(b"\r\n") else b"\n"
        if not raw_lines[index].endswith((b"\n", b"\r")):
            ending = b""
        raw_lines[index] = json.dumps(row, ensure_ascii=False).encode("utf-8") + ending
        _atomic_write(QUIZ_FILE, b"".join(raw_lines))


def compute_stats(round_progress):
    if not isinstance(round_progress, dict) or any(type(value) is not bool for value in round_progress.values()):
        raise DataError("Los resultados deben ser valores booleanos.")
    asked = len(round_progress)
    correct = sum(round_progress.values())
    wrong = asked - correct
    pct = correct / asked * 100 if asked else 0.0
    return asked, correct, wrong, pct


def set_css_style(css_path: Path):
    if not css_path.exists():
        return
    try:
        css = css_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        logger.warning("No se pudo cargar la hoja de estilos.")
        return
    st.markdown(f"<style>{css}</style>", unsafe_allow_html=True)
