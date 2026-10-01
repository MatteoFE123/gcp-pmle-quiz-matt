import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]


class StreamlitFlows(unittest.TestCase):
    def probe(self, code, *, questions=None, progress=None):
        with tempfile.TemporaryDirectory(prefix="pmle-app-test-") as directory:
            data = Path(directory) / "data"
            data.mkdir()
            bank = questions if questions is not None else [
                {
                    "id": 1, "mode": "single_choice", "question": "Pregunta de prueba",
                    "options": ["Primera opción", "Segunda opción"], "answer": 0,
                    "explanation": "Explicación de prueba.", "gcp_topics": ["Tema A"],
                    "gcp_products": ["Alpha"], "ml_topics": ["Evaluación"],
                },
                {
                    "id": 2, "mode": "multiple_choice", "question": "Selecciona las dos opciones",
                    "options": ["Opción uno", "Opción dos", "Opción tres"], "answer": [0, 2],
                    "explanation": "Dos opciones son correctas.", "gcp_topics": ["Tema B"],
                    "gcp_products": ["Beta"], "ml_topics": [],
                },
            ]
            (data / "quizzes.jsonl").write_text("\n".join(json.dumps(q) for q in bank) + "\n", encoding="utf-8")
            products = [
                {"product_name": "Alpha", "short_description": "Producto de prueba A", "connected_to": ["Shared"], "ui": [], "use_cases": [], "not_used_when": []},
                {"product_name": "Beta", "short_description": "Producto de prueba B", "connected_to": [], "ui": [], "use_cases": [], "not_used_when": []},
            ]
            (data / "gcp_products.jsonl").write_text("\n".join(json.dumps(p) for p in products), encoding="utf-8")
            if progress is not None:
                (data / "progress.json").write_text(json.dumps(progress), encoding="utf-8")
            environment = {
                **os.environ, "QUIZ_DATA_DIR": str(data), "QUIZ_CACHE_DIR": str(Path(directory) / "cache"),
                "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
            }
            prelude = f"""
from pathlib import Path
from streamlit.testing.v1 import AppTest
ROOT = Path({str(ROOT)!r})
DATA = Path({str(data)!r})
def button(app, label):
    return next(item for item in app.button if item.label == label)
def clean(app):
    assert not app.exception, [item.message for item in app.exception]
def page(name):
    app = AppTest.from_file(ROOT / name, default_timeout=20).run()
    clean(app)
    return app
"""
            result = subprocess.run(
                [sys.executable, "-B", "-c", textwrap.dedent(prelude) + "\n" + textwrap.dedent(code)],
                cwd=ROOT, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)

    def test_home_and_legacy_entry_paths(self):
        self.probe("""
app = page("🏠_Dashboard.py")
assert app.title[0].value == "Tu próxima sesión de estudio"
assert [metric.value for metric in app.metric] == ["2", "2", "0", "0"]
button(app, "Preparar práctica").click().run()
clean(app)
assert app.title[0].value == "Práctica"
""")

    def test_answer_restore_save_and_export(self):
        self.probe("""
app = page("pages/3_🤔_Quiz_Mode.py")
button(app, "Empezar ronda").click().run()
clean(app)
question = app.session_state.quizzes[0]
if question.mode == "single_choice":
    app.radio[0].set_value(question.answer).run()
else:
    for index in question.answer:
        app.checkbox[index].check().run()
button(app, "Comprobar respuesta").click().run()
clean(app)
assert app.session_state.quiz_mode_round_progress == {0: True}
assert all(widget.disabled for widget in list(app.radio) + list(app.checkbox))
restored = page("pages/3_🤔_Quiz_Mode.py")
assert restored.session_state.quiz_mode_round_progress == {0: True}
assert restored.session_state.quiz_mode_selections[0]
assert all(widget.disabled for widget in list(restored.radio) + list(restored.checkbox))
button(restored, "Ver resumen").click().run()
button(restored, "Guardar resultados").click().run()
clean(restored)
import json
assert json.loads((DATA / "progress.json").read_text()) == {str(question.id): True}
assert not restored.session_state.quiz_in_progress
export = page("pages/5_🇦🇮_Export_for_LM.py")
export.selectbox[0].select("Preguntas acertadas").run()
clean(export)
assert export.metric[0].value == "1"
""")

    def test_skip_and_review_do_not_commit(self):
        self.probe("""
app = page("pages/3_🤔_Quiz_Mode.py")
button(app, "Empezar ronda").click().run()
button(app, "Saltar por ahora").click().run()
button(app, "Ver resumen").click().run()
clean(app)
assert button(app, "Guardar resultados").disabled
button(app, "Volver a pendientes").click().run()
assert app.session_state.quiz_mode_pos == 0
button(app, "Ver resumen").click().run()
button(app, "Confirmar descarte").click().run()
clean(app)
assert not (DATA / "progress.json").exists()
assert not app.session_state.quiz_in_progress
""")

    def test_product_filter_and_no_connections(self):
        self.probe("""
app = page("pages/2_☁️_GCP_Products.py")
app.multiselect[0].set_value(["Beta"]).run()
clean(app)
assert app.selectbox[0].value == "Beta"
app.radio[0].set_value("Conexiones").run()
clean(app)
assert any("no tienen conexiones" in item.value for item in app.info)
app.text_input[0].set_value("sin coincidencias").run()
clean(app)
assert any("No hay coincidencias" in item.value for item in app.info)
""")

    def test_review_keeps_answers_after_the_revisited_question(self):
        self.probe("""
app = page("pages/3_🤔_Quiz_Mode.py")
button(app, "Empezar ronda").click().run()
button(app, "Saltar por ahora").click().run()
question = app.session_state.quizzes[1]
if question.mode == "single_choice":
    app.radio[0].set_value(question.answer).run()
else:
    for index in question.answer:
        app.checkbox[index].check().run()
button(app, "Comprobar respuesta").click().run()
button(app, "Ver resumen").click().run()
button(app, "Volver a pendientes").click().run()
clean(app)
assert not app.error, [item.value for item in app.error]
assert app.session_state.quiz_mode_pos == 0
assert app.session_state.quiz_mode_round_progress == {1: True}
restored = page("pages/3_🤔_Quiz_Mode.py")
assert restored.session_state.quiz_mode_pos == 0
assert restored.session_state.quiz_mode_round_progress == {1: True}
""")

    def test_editor_empty_multiple_and_valid_save(self):
        self.probe("""
app = page("pages/4_📝_Edit_Questions.py")
app.selectbox[0].select(2).run()
button(app, "Editar esta pregunta").click().run()
original = (DATA / "quizzes.jsonl").read_bytes()
app.multiselect[0].set_value([]).run()
button(app, "Guardar cambios").click().run()
clean(app)
assert app.error
assert (DATA / "quizzes.jsonl").read_bytes() == original
app.multiselect[0].set_value([0]).run()
button(app, "Guardar cambios").click().run()
clean(app)
import json
edited = [json.loads(line) for line in (DATA / "quizzes.jsonl").read_text().splitlines()][1]
assert edited["answer"] == [0]
assert edited["gcp_topics"] == ["Tema B"]
""")

    def test_reset_requires_confirmation_and_keeps_backup(self):
        self.probe("""
app = page("🏠_Dashboard.py")
assert button(app, "Reiniciar historial").disabled
app.checkbox[0].check().run()
button(app, "Reiniciar historial").click().run()
clean(app)
from utils import load_progress
assert load_progress() == {}
assert [metric.value for metric in app.metric] == ["2", "2", "0", "0"]
assert any(path.name.startswith("progress") and path.name != "progress.json" for path in DATA.iterdir())
""", progress={"1": True})

    def test_dashboard_ranking_orphan_ids_and_empty_topics(self):
        self.probe("""
from dashboard import catalog_stats, topic_statistics, ranked_topics, show_dashboard
from utils import load_questions
import pandas as pd
questions = load_questions()
assert catalog_stats(questions, {999:True})["unanswered"] == 2
stats = pd.DataFrame({"topic":list("ABCDEF"),"gap":[1,.9,.8,.7,.6,.5],"accuracy":[0,.1,.2,.3,.4,.5],"attempts":[6,5,4,3,2,1]})
for order in ["Más fallos primero","Menor precisión primero","Más preguntas primero"]:
    assert ranked_topics(stats, order, 5).iloc[0]["topic"] == "A"
app = AppTest.from_string("from dashboard import show_dashboard\\nshow_dashboard()", default_timeout=20).run()
clean(app)
app.selectbox[0].select("Machine learning").run()
clean(app)
assert any("Todavía no hay resultados" in item.value for item in app.info)
""", progress={"2": False})

    def test_export_scope_and_explanations(self):
        self.probe("""
import runpy
namespace = runpy.run_path(str(ROOT / "pages/5_🇦🇮_Export_for_LM.py"))
text = namespace["export_false_questions"]()
assert "Pregunta #2" in text and "Pregunta #1" not in text
assert "### Explicación" in text
""", progress={"1": True, "2": False})

    def test_corrupt_progress_stays_untouched(self):
        self.probe("""
(DATA / "progress.json").write_text("{broken", encoding="utf-8")
app = page("🏠_Dashboard.py")
assert app.error
assert (DATA / "progress.json").read_text() == "{broken"
""")


if __name__ == "__main__":
    unittest.main()
