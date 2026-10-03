import csv
import html
import json
import re
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
QUIZZES_PATH = ROOT / "data" / "quizzes.jsonl"
CSV_PATH = ROOT / "data" / "study-plan-2026-10.csv"
HTML_PATH = ROOT / "_docs" / "study-plan-2026-10.html"

BLOCKS = {
    1: {
        "name": "Datos, diseño y fundamentos de ML",
        "short": "Datos y diseño",
        "goal": "Entender el problema, preparar los datos y elegir cómo construir y medir el modelo.",
        "keywords": [
            "data",
            "storage",
            "ingestion",
            "preprocess",
            "pre-processing",
            "feature",
            "classification",
            "regression",
            "clustering",
            "forecast",
            "metric",
            "evaluation",
            "explain",
            "responsible",
            "bias",
            "natural language",
            "computer vision",
            "automl",
            "bigquery",
            "sql",
        ],
    },
    2: {
        "name": "Entrenamiento, escalado y optimización",
        "short": "Entrenamiento",
        "goal": "Dominar el entrenamiento, los hiperparámetros, el hardware y la mejora del rendimiento.",
        "keywords": [
            "training",
            "train",
            "tensorflow",
            "pytorch",
            "hyperparameter",
            "distributed",
            "gpu",
            "tpu",
            "compute engine",
            "custom job",
            "custom training",
            "optimization",
            "overfitting",
            "underfitting",
            "regularization",
            "batch size",
            "vertex ai workbench",
            "notebook",
        ],
    },
    3: {
        "name": "Producción, MLOps y monitorización",
        "short": "Producción y MLOps",
        "goal": "Llevar modelos a producción, automatizar el ciclo de vida y detectar degradación.",
        "keywords": [
            "deploy",
            "serving",
            "prediction",
            "endpoint",
            "monitor",
            "drift",
            "skew",
            "retrain",
            "pipeline",
            "mlops",
            "orchestration",
            "registry",
            "metadata",
            "experiment",
            "kubeflow",
            "ci/cd",
            "cloud build",
            "cloud function",
            "scheduler",
            "pub/sub",
            "security",
            "iam",
            "access control",
        ],
    },
}

BLOCK_DATES = {
    1: [date(2026, 10, 4) + timedelta(days=offset) for offset in range(7)],
    2: [date(2026, 10, 11) + timedelta(days=offset) for offset in range(7)],
    3: [date(2026, 10, 18) + timedelta(days=offset) for offset in range(7)],
}

CAPACITIES = {1: 280, 2: 280, 3: 281}


def load_questions():
    with QUIZZES_PATH.open(encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def searchable_text(question):
    fields = [
        question.get("question", ""),
        *question.get("gcp_topics", []),
        *question.get("ml_topics", []),
        *question.get("gcp_products", []),
    ]
    return " ".join(fields).lower()


def score_question(question):
    text = searchable_text(question)
    scores = {}
    for block, details in BLOCKS.items():
        scores[block] = sum(text.count(keyword) for keyword in details["keywords"])
    return scores


def assign_blocks(questions):
    ranked = []
    for question in questions:
        scores = score_question(question)
        ordered_scores = sorted(scores.values(), reverse=True)
        margin = ordered_scores[0] - ordered_scores[1]
        ranked.append((margin, max(scores.values()), question["id"], question, scores))

    remaining = CAPACITIES.copy()
    assignments = {block: [] for block in BLOCKS}
    for _, _, _, question, scores in sorted(ranked, key=lambda item: (-item[0], -item[1], item[2])):
        available = [block for block, capacity in remaining.items() if capacity]
        chosen = max(available, key=lambda block: (scores[block], remaining[block], -block))
        assignments[chosen].append(question)
        remaining[chosen] -= 1

    for block in assignments:
        assignments[block].sort(
            key=lambda question: (
                -score_question(question)[block],
                question["id"],
            )
        )
    return assignments


def daily_counts(block):
    return [40] * 7 if block != 3 else [41, 40, 40, 40, 40, 40, 40]


def build_schedule(assignments):
    schedule = []
    for block in BLOCKS:
        cursor = 0
        for study_date, count in zip(BLOCK_DATES[block], daily_counts(block)):
            day_questions = assignments[block][cursor : cursor + count]
            for position, question in enumerate(day_questions, start=1):
                schedule.append(
                    {
                        "date": study_date.isoformat(),
                        "block": block,
                        "position": position,
                        "question": question,
                    }
                )
            cursor += count
    return schedule


def clean_text(value):
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def join_field(question, field):
    return " | ".join(question.get(field, []))


def write_csv(schedule):
    columns = [
        "fecha",
        "bloque",
        "nombre_bloque",
        "posicion_del_dia",
        "id_pregunta",
        "tipo",
        "temas_gcp",
        "temas_ml",
        "productos_gcp",
        "pregunta",
    ]
    with CSV_PATH.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=columns)
        writer.writeheader()
        for item in schedule:
            question = item["question"]
            writer.writerow(
                {
                    "fecha": item["date"],
                    "bloque": item["block"],
                    "nombre_bloque": BLOCKS[item["block"]]["name"],
                    "posicion_del_dia": item["position"],
                    "id_pregunta": question["id"],
                    "tipo": question["mode"],
                    "temas_gcp": join_field(question, "gcp_topics"),
                    "temas_ml": join_field(question, "ml_topics"),
                    "productos_gcp": join_field(question, "gcp_products"),
                    "pregunta": clean_text(question["question"]),
                }
            )


def render_daily_rows(schedule):
    rows = []
    weekdays = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
    grouped = {}
    for item in schedule:
        grouped.setdefault((item["block"], item["date"]), []).append(item["question"]["id"])
    for (block, iso_date), ids in grouped.items():
        current = date.fromisoformat(iso_date)
        label = f"{weekdays[current.weekday()]} {current.day}"
        ids_text = ", ".join(str(question_id) for question_id in ids)
        rows.append(
            f"""
            <tr>
              <td><strong>{html.escape(label)}</strong></td>
              <td><span class="block block-{block}">Bloque {block}</span></td>
              <td>{len(ids)}</td>
              <td><details><summary>Ver IDs</summary><p class="ids">{ids_text}</p></details></td>
            </tr>"""
        )
    return "\n".join(rows)


def write_html(schedule):
    block_cards = []
    for block, details in BLOCKS.items():
        start = BLOCK_DATES[block][0].day
        end = BLOCK_DATES[block][-1].day
        block_cards.append(
            f"""
            <article class="card">
              <p class="eyebrow">BLOQUE {block} · {CAPACITIES[block]} PREGUNTAS · {start}–{end} OCT</p>
              <h3>{html.escape(details["name"])}</h3>
              <p>{html.escape(details["goal"])}</p>
            </article>"""
        )

    content = f"""<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plan PMLE · Examen 28 de octubre de 2026</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #111210;
      --surface: #1a1c19;
      --surface-2: #222520;
      --text: #f1f0e8;
      --muted: #aaada3;
      --line: #363a33;
      --accent: #d7ff68;
      --blue: #8cc8ff;
      --orange: #ffbd7a;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{ width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 96px; }}
    h1, h2, h3 {{ line-height: 1.08; letter-spacing: -0.025em; }}
    h1 {{ max-width: 850px; margin: 10px 0 22px; font-size: clamp(2.5rem, 7vw, 5.6rem); }}
    h2 {{ margin: 72px 0 20px; font-size: clamp(1.8rem, 4vw, 3rem); }}
    h3 {{ margin: 8px 0 12px; font-size: 1.35rem; }}
    p {{ max-width: 760px; color: var(--muted); }}
    strong {{ color: var(--text); }}
    .eyebrow {{ margin: 0; color: var(--accent); font-size: .78rem; font-weight: 750; letter-spacing: .12em; }}
    .lead {{ font-size: 1.15rem; }}
    .summary {{
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      margin-top: 42px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--line);
    }}
    .metric {{ padding: 24px; background: var(--surface); }}
    .metric b {{ display: block; color: var(--text); font-size: 2rem; }}
    .metric span {{ color: var(--muted); }}
    .cards {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }}
    .card {{ padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }}
    .card p:last-child {{ margin-bottom: 0; }}
    .method {{
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin: 20px 0;
      padding: 0;
      list-style: none;
      counter-reset: steps;
    }}
    .method li {{ padding: 22px; border-top: 2px solid var(--accent); background: var(--surface); }}
    .method li::before {{ counter-increment: steps; content: "0" counter(steps); display: block; color: var(--accent); font-weight: 750; }}
    table {{ width: 100%; border-collapse: collapse; overflow: hidden; border: 1px solid var(--line); background: var(--surface); }}
    th, td {{ padding: 13px 15px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ color: var(--muted); background: var(--surface-2); font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; }}
    td:nth-child(3) {{ width: 90px; }}
    summary {{ cursor: pointer; color: var(--accent); font-weight: 700; }}
    .ids {{ max-width: 620px; margin: 8px 0 0; color: var(--text); font: .9rem/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }}
    .block {{ display: inline-block; padding: 2px 9px; border-radius: 999px; color: #111; font-size: .78rem; font-weight: 750; }}
    .block-1 {{ background: var(--accent); }}
    .block-2 {{ background: var(--blue); }}
    .block-3 {{ background: var(--orange); }}
    .review {{ padding: 24px; border-left: 3px solid var(--accent); background: var(--surface); }}
    .review li {{ margin: 10px 0; }}
    .note {{ padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); }}
    a {{ color: var(--accent); }}
    @media (max-width: 760px) {{
      main {{ padding-top: 42px; }}
      .summary, .cards, .method {{ grid-template-columns: 1fr; }}
      th:nth-child(2), td:nth-child(2) {{ display: none; }}
      th, td {{ padding: 11px 10px; }}
    }}
    @media print {{
      :root {{ color-scheme: light; --bg: #fff; --surface: #fff; --surface-2: #f5f5f1; --text: #111; --muted: #444; --line: #bbb; --accent: #446000; }}
      main {{ width: 100%; padding: 0; }}
      details {{ open: true; }}
      .card, tr {{ break-inside: avoid; }}
    }}
  </style>
</head>
<body>
<main>
  <p class="eyebrow">PLAN PERSONAL · GOOGLE CLOUD PMLE</p>
  <h1>841 preguntas.<br>21 días para dominarlas.</h1>
  <p class="lead">Primera vuelta completa del <strong>4 al 24 de octubre de 2026</strong>. Los días 25, 26 y 27 se usan para corregir fallos y practicar. El examen es el <strong>28 de octubre</strong>.</p>

  <section class="summary" aria-label="Resumen">
    <div class="metric"><b>841</b><span>preguntas asignadas</span></div>
    <div class="metric"><b>40</b><span>preguntas por día, salvo una sesión de 41</span></div>
    <div class="metric"><b>3</b><span>días finales de repaso</span></div>
  </section>

  <h2>Hoy, 3 de octubre</h2>
  <p class="note"><strong>Prepara el sistema en 30 minutos.</strong> Abre la aplicación, guarda una copia de tu progreso y crea una hoja con cuatro columnas: ID, resultado, duda y tema a revisar. No intentes avanzar preguntas hoy; deja preparado el seguimiento para empezar mañana.</p>

  <h2>Los tres bloques</h2>
  <div class="cards">
    {"".join(block_cards)}
  </div>

  <h2>Rutina diaria</h2>
  <ol class="method">
    <li><strong>Ronda 1</strong><br>20 preguntas sin mirar apuntes. Marca las dudosas.</li>
    <li><strong>Corrección</strong><br>Lee cada explicación. Anota por qué fallaste, no solo la respuesta.</li>
    <li><strong>Ronda 2</strong><br>20 preguntas y 15 minutos de repaso de los fallos del día anterior.</li>
  </ol>
  <p class="note"><strong>Regla útil:</strong> una pregunta solo cuenta como estudiada si puedes explicar por qué la opción correcta es mejor y por qué las demás no lo son. Tiempo orientativo: 2½–3½ horas al día.</p>

  <h2>Calendario de la primera vuelta</h2>
  <table>
    <thead><tr><th>Fecha</th><th>Bloque</th><th>Cantidad</th><th>Preguntas</th></tr></thead>
    <tbody>
      {render_daily_rows(schedule)}
    </tbody>
  </table>

  <h2>Repaso final</h2>
  <div class="review">
    <ol>
      <li><strong>25 de octubre — reparar puntos débiles.</strong> Repite todas las preguntas falladas y dudosas. Agrupa los errores por tema y crea una nota corta por tema.</li>
      <li><strong>26 de octubre — simulacro.</strong> Haz dos rondas mixtas de 50 preguntas, sin apuntes y con límite de tiempo. Corrige todo al terminar.</li>
      <li><strong>27 de octubre — consolidar y descansar.</strong> Repite solo los fallos del simulacro, revisa servicios parecidos y termina pronto. No abras temas nuevos.</li>
      <li><strong>28 de octubre — examen.</strong> Repaso ligero de 20–30 minutos como máximo. Lee bien palabras como <em>first</em>, <em>best</em>, <em>minimum effort</em> y <em>cost-effective</em>.</li>
    </ol>
  </div>

  <h2>Cómo medir si vas bien</h2>
  <p>Al final de cada bloque, busca al menos <strong>80 % de aciertos</strong> al repetir los fallos. Si quedas por debajo, no añadas más teoría: revisa primero las explicaciones y compara los productos que confundiste.</p>
  <p>El archivo <a href="../data/study-plan-2026-10.csv">study-plan-2026-10.csv</a> contiene las 841 filas, con fecha, ID, temas, productos y enunciado. Sirve para filtrar o marcar el avance en Excel o Google Sheets.</p>
  <p class="note">Este banco es material de práctica y no garantiza el resultado del examen. Las preguntas se agruparon usando sus etiquetas actuales; algunas cubren más de un bloque.</p>
</main>
</body>
</html>
"""
    HTML_PATH.write_text(content, encoding="utf-8")


def validate(schedule):
    expected_ids = {question["id"] for question in load_questions()}
    scheduled_ids = [item["question"]["id"] for item in schedule]
    if len(scheduled_ids) != 841:
        raise ValueError(f"Se esperaban 841 asignaciones y hay {len(scheduled_ids)}.")
    if len(set(scheduled_ids)) != len(scheduled_ids):
        raise ValueError("Hay preguntas repetidas en el plan.")
    if set(scheduled_ids) != expected_ids:
        raise ValueError("El plan no contiene exactamente los IDs del banco.")
    for block, expected in CAPACITIES.items():
        actual = sum(item["block"] == block for item in schedule)
        if actual != expected:
            raise ValueError(f"El bloque {block} tiene {actual} preguntas; se esperaban {expected}.")


def main():
    questions = load_questions()
    assignments = assign_blocks(questions)
    schedule = build_schedule(assignments)
    validate(schedule)
    write_csv(schedule)
    write_html(schedule)
    print(f"Plan generado: {len(schedule)} preguntas, {len(set(item['question']['id'] for item in schedule))} IDs únicos.")


if __name__ == "__main__":
    main()
