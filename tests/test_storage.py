import json
import os
import shutil
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from diskcache import Cache
from pydantic import ValidationError

from models.questions import Question
import utils
from utils import DataError
import utils.session as session


def example(question_id=1, **changes):
    return {
        "id": question_id,
        "mode": "single_choice",
        "question": "Pregunta sintética",
        "options": ["Primera", "Segunda", "Tercera"],
        "answer": 0,
        "explanation": "Explicación sintética",
        **changes,
    }


class SimulatedRerun(BaseException):
    pass


class InterruptibleState(dict):
    pending_rerun = False

    def _yield(self):
        if self.pending_rerun:
            self.pending_rerun = False
            raise SimulatedRerun

    def __getitem__(self, key):
        self._yield()
        return super().__getitem__(key)

    def __setitem__(self, key, value):
        self._yield()
        return super().__setitem__(key, value)

    def get(self, key, default=None):
        self._yield()
        return super().get(key, default)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent / f".storage-fixtures-{uuid4().hex}"
        self.root.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.cache_dir = self.root / "cache"
        self.quiz = self.data / "quizzes.jsonl"
        self.progress = self.data / "progress.json"
        self.state = {}
        self.patches = [
            patch.multiple(utils, DATA_DIR=self.data, QUIZ_FILE=self.quiz, PROGRESS_FILE=self.progress),
            patch.object(session, "CACHE_DIR", self.cache_dir),
            patch.object(session.st, "session_state", self.state),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for item in reversed(self.patches):
            item.stop()
        shutil.rmtree(self.root)

    def write_questions(self, *rows):
        self.quiz.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

    def start_round(self):
        session.load_session()
        self.state.update(
            quiz_in_progress=True,
            quizzes=[Question(**example())],
            quiz_mode_pos=0,
            quiz_mode_round_progress={},
            quiz_mode_selections={},
            round_id=uuid4().hex,
        )
        session.cache_session()

    def test_model_strict_answers_and_metadata(self):
        invalid = [
            {"answer": [0]},
            {"mode": "multiple_choice", "answer": 0},
            {"mode": "multiple_choice", "answer": []},
            {"mode": "multiple_choice", "answer": [0, 0]},
            {"answer": -1},
            {"answer": 3},
            {"answer": True},
            {"answer": "0"},
            {"options": []},
            {"options": [" "]},
            {"question": " "},
            {"id": True},
            {"id": 0},
            {"gcp_topics": "Tema"},
        ]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                Question(**example(**values))
        q = Question(**example(mode="multiple_choice", answer=[0], custom={"kept": True}))
        self.assertEqual(q.gcp_topics, [])
        self.assertEqual(q.gcp_products, [])
        self.assertEqual(q.ml_topics, [])
        self.assertEqual(q.model_dump()["custom"], {"kept": True})

    def test_catalog_normalizes_only_in_memory(self):
        self.write_questions(example(mode="multiple_choice", answer=0))
        original = self.quiz.read_bytes()
        with self.assertLogs(utils.logger, level="WARNING"):
            questions = utils.load_questions()
        self.assertEqual(questions[0].answer, [0])
        self.assertEqual(self.quiz.read_bytes(), original)

    def test_catalog_errors_are_consistent(self):
        with self.assertRaises(DataError):
            utils.load_questions()
        for content in ["", "\n", "{broken\n", json.dumps(example()) + "\n" + json.dumps(example())]:
            self.quiz.write_text(content, encoding="utf-8")
            with self.subTest(content=content), self.assertRaises(DataError):
                utils.load_questions()
        self.write_questions(example(answer=99))
        with self.assertRaises(DataError):
            utils.load_quizzes({})

    def test_question_categories_and_stats(self):
        self.write_questions(example(1), example(2), example(3))
        groups = utils.load_quizzes({1: False, 3: True})
        self.assertEqual([[q.id for q in group] for group in groups], [[1], [2], [3]])
        self.assertEqual(utils.compute_stats({0: True, 1: False}), (2, 1, 1, 50.0))
        self.assertEqual(utils.compute_stats({}), (0, 0, 0, 0.0))
        with self.assertRaises(DataError):
            utils.compute_stats({0: "false"})

    def test_progress_merge_backup_reset(self):
        self.assertEqual(utils.load_progress(), {})
        utils.save_progress({1: True})
        original = self.progress.read_bytes()
        self.assertEqual(utils.update_progress({2: False}), {1: True, 2: False})
        self.assertEqual(self.progress.with_name("progress.json.bak").read_bytes(), original)
        before_reset = self.progress.read_bytes()
        utils.reset_progress()
        self.assertEqual(utils.load_progress(), {})
        self.assertEqual(self.progress.with_name("progress.json.bak").read_bytes(), before_reset)

    def test_corruption_never_overwritten(self):
        for content in [
            b"{broken",
            b'{"1":"false"}',
            b'{"1":1}',
            b'{"bad":true}',
            b'{"1":true,"1":false}',
            b'{"01":true}',
            b'[]',
            b'\xff',
        ]:
            self.progress.write_bytes(content)
            for operation in [utils.load_progress, lambda: utils.save_progress({}), lambda: utils.update_progress({2: True}), utils.reset_progress]:
                with self.subTest(content=content, operation=operation), self.assertRaises(DataError):
                    operation()
                self.assertEqual(self.progress.read_bytes(), content)

    def test_failed_atomic_replace_keeps_original(self):
        utils.save_progress({1: True})
        original = self.progress.read_bytes()
        replace = os.replace

        def fail_progress(source, destination):
            if Path(destination) == self.progress:
                raise OSError("synthetic")
            return replace(source, destination)

        with patch.object(utils.os, "replace", side_effect=fail_progress), self.assertRaises(DataError):
            utils.update_progress({2: True})
        self.assertEqual(self.progress.read_bytes(), original)
        self.assertEqual(list(self.data.glob("*.pending")), [])

    def test_concurrent_thread_updates_do_not_lose_results(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda value: utils.update_progress({value: True}), range(1, 19)))
        self.assertEqual(utils.load_progress(), dict.fromkeys(range(1, 19), True))

    def test_concurrent_process_updates_and_environment_paths(self):
        env = dict(os.environ, QUIZ_DATA_DIR=str(self.data), QUIZ_CACHE_DIR=str(self.cache_dir))
        code = (
            "import utils,utils.session as s; "
            "assert str(utils.DATA_DIR)==__import__('os').environ['QUIZ_DATA_DIR']; "
            "assert str(s.CACHE_DIR)==__import__('os').environ['QUIZ_CACHE_DIR']; "
            "[utils.update_progress({i:True}) for i in range(START,START+5)]"
        )
        processes = [
            subprocess.Popen(
                [sys.executable, "-B", "-c", code.replace("START", str(start))],
                cwd=utils.ROOT_DIR,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for start in (1, 6)
        ]
        for process in processes:
            output, error = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, error.decode("utf-8", errors="replace"))
        self.assertEqual(len(utils.load_progress()), 10)

    def test_edit_preserves_other_rows_metadata_and_detects_conflict(self):
        first = json.dumps(example(1, custom={"retained": [1, 2]})).encode() + b"\r\n"
        second = b"  " + json.dumps(example(2)).encode() + b"\r\n"
        self.quiz.write_bytes(first + second)
        original = utils.load_questions()[0]
        updated = original.model_copy(update={"answer": 1, "explanation": "Nueva explicación"})
        utils.save_question(updated, original)
        self.assertEqual(self.quiz.read_bytes().splitlines(keepends=True)[1], second)
        self.assertEqual(utils.load_questions()[0].model_extra["custom"], {"retained": [1, 2]})
        self.assertEqual(self.quiz.with_name("quizzes.jsonl.bak").read_bytes(), first + second)
        with self.assertRaises(DataError):
            utils.save_question(original, original)
        with self.assertRaises(DataError):
            utils.save_question(updated.model_copy(update={"id": 3}), updated)

    def test_invalid_edit_does_not_write(self):
        self.write_questions(example())
        before = self.quiz.read_bytes()
        original = utils.load_questions()[0]
        with self.assertRaises(DataError):
            utils.save_question(original.model_copy(update={"answer": []}), original)
        self.assertEqual(self.quiz.read_bytes(), before)

    def test_resume_preserves_answer_and_selection(self):
        self.start_round()
        self.state["quiz_mode_round_progress"] = {0: False}
        self.state["quiz_mode_selections"] = {0: [1]}
        session.cache_session()
        self.state.clear()
        session.load_session()
        self.assertTrue(self.state["quiz_mode_answered"])
        self.assertEqual(self.state["quiz_mode_selections"], {0: [1]})
        self.assertEqual(self.state["quiz_mode_round_progress"], {0: False})

    def test_load_only_once_and_stale_tab_cannot_overwrite_or_clear(self):
        self.start_round()
        first_tab = deepcopy(self.state)
        self.state.clear()
        session.load_session()
        self.state["quiz_mode_selections"] = {0: [1]}
        session.cache_session()
        second_revision = self.state["_quiz_session_revision"]["value"]
        self.state.clear()
        self.state.update(first_tab)
        session.load_session()
        self.assertEqual(self.state["_quiz_session_revision"], first_tab["_quiz_session_revision"])
        for operation in [session.cache_session, session.clear_session_cache]:
            with self.assertRaisesRegex(DataError, "otra pestaña"):
                operation()
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.SESSION_KEY]["revision"], second_revision)

    def test_clear_tombstone_prevents_resurrection(self):
        self.start_round()
        stale = deepcopy(self.state)
        session.clear_session_cache()
        with Cache(str(self.cache_dir)) as storage:
            self.assertTrue(storage[session.SESSION_BACKUP_KEY]["state"]["quiz_in_progress"])
        self.state.clear()
        session.load_session()
        self.assertFalse(self.state["quiz_in_progress"])
        self.state.clear()
        self.state.update(stale)
        with self.assertRaises(DataError):
            session.cache_session()

    def test_legacy_round_is_recoverable_without_invented_selection(self):
        legacy = {
            "quiz_in_progress": True,
            "quizzes": [example()],
            "quiz_mode_pos": 0,
            "quiz_mode_round_progress": {0: False},
        }
        with Cache(str(self.cache_dir)) as storage:
            for key, value in legacy.items():
                storage.set(key, value)
        session.load_session()
        self.assertTrue(self.state["quiz_mode_answered"])
        self.assertEqual(self.state["quiz_mode_selections"], {})
        session.cache_session()
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.LEGACY_BACKUP_KEY], legacy)
            self.assertEqual(storage["quiz_mode_round_progress"], {0: False})
            self.assertEqual(storage[session.SESSION_KEY]["version"], 1)

    def test_malformed_session_is_not_replaced(self):
        record = {"version": 99, "revision": 1, "state": {}}
        with Cache(str(self.cache_dir)) as storage:
            storage.set(session.SESSION_KEY, record)
        with self.assertRaises(DataError):
            session.load_session()
        self.assertNotIn("_quiz_session_loaded", self.state)
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.SESSION_KEY], record)

    def test_session_rejects_invalid_cursor_selection_score_and_revision(self):
        self.start_round()
        valid = deepcopy(self.state)
        for changes in [
            {"quiz_mode_pos": -1},
            {"quiz_mode_pos": 2},
            {"quiz_mode_round_progress": {1: True}},
            {"quiz_mode_selections": {0: [8]}},
            {"quiz_mode_selections": {0: [0, 1]}},
            {"quiz_mode_selections": {0: [1]}, "quiz_mode_round_progress": {0: True}},
            {"_quiz_session_revision": True},
        ]:
            self.state.clear()
            self.state.update(valid | changes)
            with self.subTest(changes=changes), self.assertRaises(DataError):
                session.cache_session()

    def test_root_defaults_do_not_depend_on_working_directory(self):
        env = {key: value for key, value in os.environ.items() if key not in {"QUIZ_DATA_DIR", "QUIZ_CACHE_DIR"}}
        code = (
            "import os,sys; "
            f"sys.path.insert(0,{str(utils.ROOT_DIR)!r}); "
            "import utils,utils.session as s; "
            "assert utils.DATA_DIR == utils.ROOT_DIR / 'data'; "
            "assert s.CACHE_DIR == utils.ROOT_DIR / 'cache'"
        )
        result = subprocess.run(
            [sys.executable, "-B", "-c", code], cwd=self.root, env=env, capture_output=True, timeout=30
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertFalse((self.root / "cache").exists())

    def test_question_write_failure_preserves_original_and_backup(self):
        self.write_questions(example())
        before = self.quiz.read_bytes()
        original = utils.load_questions()[0]
        replace = os.replace

        def fail_question(source, destination):
            if Path(destination) == self.quiz:
                raise OSError("synthetic")
            return replace(source, destination)

        with patch.object(utils.os, "replace", side_effect=fail_question), self.assertRaises(DataError):
            utils.save_question(original.model_copy(update={"answer": 1}), original)
        self.assertEqual(self.quiz.read_bytes(), before)
        self.assertEqual(self.quiz.with_name("quizzes.jsonl.bak").read_bytes(), before)

    def test_completed_round_and_missing_legacy_selections_are_valid(self):
        self.start_round()
        self.state["quiz_mode_round_progress"] = {0: True}
        self.state["quiz_mode_pos"] = 1
        session.cache_session()
        self.state.clear()
        session.load_session()
        self.assertEqual(self.state["quiz_mode_pos"], 1)
        self.assertFalse(self.state["quiz_mode_answered"])
        self.assertEqual(self.state["quiz_mode_round_progress"], {0: True})

    def test_finish_round_saves_id_results_before_clearing_checkpoint(self):
        utils.save_progress({99: False})
        self.start_round()
        self.state["quiz_mode_selections"] = {0: [0]}
        self.state["quiz_mode_round_progress"] = {0: True}
        session.cache_session()
        previous_revision = self.state["_quiz_session_revision"]["value"]
        session.finish_round(True)
        self.assertEqual(utils.load_progress(), {99: False, 1: True})
        self.assertTrue(self.state["quiz_in_progress"])
        self.assertEqual(self.state["_quiz_session_revision"]["value"], previous_revision + 1)
        with Cache(str(self.cache_dir)) as storage:
            self.assertFalse(storage[session.SESSION_KEY]["state"]["quiz_in_progress"])
            self.assertEqual(storage[session.SESSION_BACKUP_KEY]["state"]["quiz_mode_round_progress"], {0: True})

    def test_stale_finish_cannot_commit_progress(self):
        self.start_round()
        first_tab = deepcopy(self.state)
        self.state["quiz_mode_selections"] = {0: [0]}
        self.state["quiz_mode_round_progress"] = {0: True}
        session.cache_session()
        self.state.clear()
        self.state.update(first_tab)
        with patch.object(session, "update_progress") as update:
            with self.assertRaisesRegex(DataError, "otra pestaña"):
                session.finish_round(True)
            update.assert_not_called()
        self.assertFalse(self.progress.exists())
        with Cache(str(self.cache_dir)) as storage:
            self.assertTrue(storage[session.SESSION_KEY]["state"]["quiz_in_progress"])

    def test_failed_finish_keeps_checkpoint_and_revision_for_retry(self):
        self.start_round()
        self.state["quiz_mode_selections"] = {0: [1]}
        self.state["quiz_mode_round_progress"] = {0: False}
        session.cache_session()
        revision = self.state["_quiz_session_revision"]["value"]
        with patch.object(session, "update_progress", side_effect=DataError("Fallo sintético")):
            with self.assertRaises(DataError):
                session.finish_round(True)
        self.assertEqual(self.state["_quiz_session_revision"]["value"], revision)
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.SESSION_KEY]["revision"], revision)
            self.assertEqual(storage[session.SESSION_KEY]["state"]["quiz_mode_round_progress"], {0: False})
        session.finish_round(True)
        self.assertEqual(utils.load_progress(), {1: False})

    def test_discard_never_writes_progress(self):
        self.start_round()
        with patch.object(session, "update_progress") as update:
            session.finish_round(False)
            update.assert_not_called()
        self.assertFalse(self.progress.exists())
        with Cache(str(self.cache_dir)) as storage:
            self.assertFalse(storage[session.SESSION_KEY]["state"]["quiz_in_progress"])

    def test_commit_acknowledges_revision_before_pending_rerun(self):
        self.start_round()
        state = InterruptibleState(self.state)
        revision = state["_quiz_session_revision"]["value"]
        store = session._store_record

        def arm_rerun(*args):
            store(*args)
            state.pending_rerun = True

        with patch.object(session.st, "session_state", state):
            with patch.object(session, "_store_record", side_effect=arm_rerun):
                with self.assertRaises(SimulatedRerun):
                    session.cache_session()
            self.assertEqual(state["_quiz_session_revision"]["value"], revision + 1)
            with Cache(str(self.cache_dir)) as storage:
                self.assertEqual(storage[session.SESSION_KEY]["revision"], revision + 1)
            session.cache_session()
            self.assertEqual(state["_quiz_session_revision"]["value"], revision + 2)

    def test_finish_acknowledges_revision_before_caller_is_interrupted(self):
        self.start_round()
        state = InterruptibleState(self.state)
        revision = state["_quiz_session_revision"]["value"]
        store = session._store_record

        def arm_rerun(*args):
            store(*args)
            state.pending_rerun = True

        with patch.object(session.st, "session_state", state):
            with patch.object(session, "_store_record", side_effect=arm_rerun):
                session.finish_round(True)
            with self.assertRaises(SimulatedRerun):
                state["quiz_in_progress"] = False
            self.assertEqual(state["_quiz_session_revision"]["value"], revision + 1)
            session.finish_round(False)
            self.assertEqual(state["_quiz_session_revision"]["value"], revision + 2)

    def test_failed_cache_transaction_does_not_advance_holder(self):
        self.start_round()
        revision = self.state["_quiz_session_revision"]["value"]
        store = session._store_record

        def fail_after_write(*args):
            store(*args)
            raise session.sqlite3.OperationalError("synthetic")

        with patch.object(session, "_store_record", side_effect=fail_after_write):
            with self.assertRaises(DataError):
                session.cache_session()
        self.assertEqual(self.state["_quiz_session_revision"]["value"], revision)
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.SESSION_KEY]["revision"], revision)
        session.cache_session()

    def test_revisit_skipped_question_preserves_later_submission(self):
        self.start_round()
        self.state["quizzes"].append(Question(**example(2)))
        self.state["quiz_mode_pos"] = 1
        self.state["quiz_mode_selections"] = {1: [0]}
        self.state["quiz_mode_round_progress"] = {1: True}
        session.cache_session()
        self.state["quiz_mode_pos"] = 0
        session.cache_session()
        self.state.clear()
        session.load_session()
        self.assertEqual(self.state["quiz_mode_pos"], 0)
        self.assertFalse(self.state["quiz_mode_answered"])
        self.assertEqual(self.state["quiz_mode_round_progress"], {1: True})
        self.assertEqual(self.state["quiz_mode_selections"], {1: [0]})

    def test_cache_does_not_disguise_programmer_errors(self):
        with self.assertRaisesRegex(RuntimeError, "programmer"):
            with session._cache():
                raise RuntimeError("programmer")
        for error in [
            OSError("synthetic"),
            session.sqlite3.OperationalError("synthetic"),
            session.Timeout(),
            session.pickle.UnpicklingError("synthetic"),
            EOFError(),
        ]:
            with self.subTest(error=type(error)), self.assertRaises(DataError):
                with session._cache():
                    raise error

    def test_integer_revision_holder_upgrade_before_next_commit(self):
        self.start_round()
        revision = self.state["_quiz_session_revision"]["value"]
        self.state["_quiz_session_revision"] = revision
        session.cache_session()
        self.assertEqual(self.state["_quiz_session_revision"], {"value": revision + 1})

    def test_legacy_scalar_multiple_answer_resumes_without_rewriting_original(self):
        question = example(148, mode="multiple_choice", answer=1)
        legacy = {
            "quiz_in_progress": True,
            "quizzes": [question],
            "quiz_mode_pos": 0,
            "quiz_mode_round_progress": {0: False},
        }
        with Cache(str(self.cache_dir)) as storage:
            for key, value in legacy.items():
                storage.set(key, value)
        with self.assertLogs(utils.logger, level="WARNING"):
            session.load_session()
        self.assertEqual(self.state["quizzes"][0].answer, [1])
        self.assertTrue(self.state["quiz_mode_answered"])
        self.assertEqual(self.state["quiz_mode_selections"], {})
        session.cache_session()
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage["quizzes"], [question])
            self.assertEqual(storage[session.LEGACY_BACKUP_KEY], legacy)
            self.assertEqual(storage[session.SESSION_KEY]["state"]["quizzes"][0]["answer"], [1])

    def test_versioned_scalar_multiple_answer_is_rejected_not_normalized(self):
        record = {
            "version": 1,
            "revision": 1,
            "state": {
                "quiz_in_progress": True,
                "quizzes": [example(148, mode="multiple_choice", answer=1)],
                "quiz_mode_pos": 0,
                "quiz_mode_round_progress": {},
                "quiz_mode_selections": {},
                "round_id": uuid4().hex,
            },
        }
        with Cache(str(self.cache_dir)) as storage:
            storage.set(session.SESSION_KEY, record)
        with self.assertRaises(DataError):
            session.load_session()
        with Cache(str(self.cache_dir)) as storage:
            self.assertEqual(storage[session.SESSION_KEY], record)

    def test_reset_history_rejects_stale_home_and_active_round(self):
        utils.save_progress({1: True})
        before = self.progress.read_bytes()
        session.load_session()
        home_tab = deepcopy(self.state)
        self.start_round()
        active_tab = deepcopy(self.state)
        self.state.clear()
        self.state.update(home_tab)
        with patch.object(session, "reset_progress") as reset:
            with self.assertRaisesRegex(DataError, "otra pestaña"):
                session.reset_history()
            reset.assert_not_called()
        self.state.clear()
        self.state.update(active_tab)
        with patch.object(session, "reset_progress") as reset:
            with self.assertRaisesRegex(DataError, "ronda activa"):
                session.reset_history()
            reset.assert_not_called()
        self.assertEqual(self.progress.read_bytes(), before)
        with Cache(str(self.cache_dir)) as storage:
            self.assertTrue(storage[session.SESSION_KEY]["state"]["quiz_in_progress"])

    def test_reset_history_clears_progress_with_backup_and_bumps_revision(self):
        utils.save_progress({1: True, 2: False})
        before = self.progress.read_bytes()
        session.load_session()
        stale_tab = deepcopy(self.state)
        revision = self.state["_quiz_session_revision"]["value"]
        session.reset_history()
        self.assertEqual(utils.load_progress(), {})
        self.assertEqual(self.progress.with_name("progress.json.bak").read_bytes(), before)
        self.assertEqual(self.state["_quiz_session_revision"]["value"], revision + 1)
        with Cache(str(self.cache_dir)) as storage:
            record = storage[session.SESSION_KEY]
            self.assertEqual(record["revision"], revision + 1)
            self.assertFalse(record["state"]["quiz_in_progress"])
        self.state.clear()
        self.state.update(stale_tab)
        with self.assertRaisesRegex(DataError, "otra pestaña"):
            session.cache_session()

    def test_reset_history_write_failure_preserves_revision_and_history(self):
        utils.save_progress({1: True})
        before = self.progress.read_bytes()
        session.load_session()
        revision = self.state["_quiz_session_revision"]["value"]
        with patch.object(session, "reset_progress", side_effect=DataError("Fallo sintético")):
            with self.assertRaises(DataError):
                session.reset_history()
        self.assertEqual(self.progress.read_bytes(), before)
        self.assertEqual(self.state["_quiz_session_revision"]["value"], revision)
        with Cache(str(self.cache_dir)) as storage:
            self.assertNotIn(session.SESSION_KEY, storage)

    def test_reset_history_acknowledges_revision_before_caller_rerun(self):
        session.load_session()
        state = InterruptibleState(self.state)
        revision = state["_quiz_session_revision"]["value"]
        store = session._store_record

        def arm_rerun(*args):
            store(*args)
            state.pending_rerun = True

        with patch.object(session.st, "session_state", state):
            with patch.object(session, "_store_record", side_effect=arm_rerun):
                session.reset_history()
            with self.assertRaises(SimulatedRerun):
                state["message"] = "Historial reiniciado"
            self.assertEqual(state["_quiz_session_revision"]["value"], revision + 1)
            session.reset_history()


if __name__ == "__main__":
    unittest.main()
