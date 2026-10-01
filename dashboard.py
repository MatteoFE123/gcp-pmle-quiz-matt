import json

import pandas as pd
import plotly.express as px
import streamlit as st

from models.questions import Question
from ui import QUIZ_PAGE, page_heading, setup_page
from utils import DataError, load_progress, load_questions
from utils.session import load_session, reset_history

TOPIC_FIELDS = {"Temas GCP": "gcp_topics", "Productos": "gcp_products", "Machine learning": "ml_topics"}
SORTS = {
    "Más fallos primero": ("gap", False),
    "Menor precisión primero": ("accuracy", True),
    "Más preguntas primero": ("attempts", False),
}


def catalog_stats(questions: list[Question], progress: dict[int, bool]) -> dict[str, int]:
    ids = {q.id for q in questions}
    current = {key: result for key, result in progress.items() if key in ids}
    correct = sum(current.values())
    return {
        "total": len(questions),
        "correct": correct,
        "wrong": len(current) - correct,
        "unanswered": len(questions) - len(current),
    }


def topic_statistics(questions: list[Question], progress: dict[int, bool], field: str) -> pd.DataFrame:
    rows = [
        {"topic": topic, "result": progress[q.id]}
        for q in questions if q.id in progress
        for topic in set(getattr(q, field))
    ]
    if not rows:
        return pd.DataFrame(columns=["topic", "attempts", "correct", "accuracy", "gap"])
    result = (
        pd.DataFrame(rows).groupby("topic")["result"]
        .agg(attempts="count", correct="sum", accuracy="mean").reset_index()
    )
    result["gap"] = 1 - result["accuracy"]
    return result


def ranked_topics(stats: pd.DataFrame, sort_by: str, limit: int) -> pd.DataFrame:
    column, ascending = SORTS[sort_by]
    return stats.sort_values([column, "topic"], ascending=[ascending, True]).head(limit)


def show_metrics(stats: dict[str, int]):
    cols = st.columns(4)
    for col, label, key in zip(cols, ["Preguntas", "Pendientes", "Aciertos", "Fallos"], ["total", "unanswered", "correct", "wrong"]):
        col.metric(label, stats[key])


def show_home():
    setup_page("Inicio")
    page_heading("Tu próxima sesión de estudio", "Practica a tu ritmo para Google Cloud Professional Machine Learning Engineer.")
    try:
        questions = load_questions()
        progress = load_progress()
        load_session()
        stats = catalog_stats(questions, progress)
        with st.container(border=True, key="study_start"):
            if st.session_state.quiz_in_progress:
                st.subheader("Tienes una ronda pendiente")
                answered = len(st.session_state.quiz_mode_round_progress)
                st.write(f"{answered} de {len(st.session_state.quizzes)} preguntas respondidas. Continúa donde lo dejaste.")
                if st.button("Continuar ronda", type="primary", icon=":material/play_arrow:"):
                    st.switch_page(QUIZ_PAGE)
            else:
                st.subheader("Un poco de práctica, cada día")
                st.write("Elige una sesión corta, repasa tus fallos o céntrate en un tema.")
                if st.button("Preparar práctica", type="primary", icon=":material/play_arrow:"):
                    st.switch_page(QUIZ_PAGE)
        st.subheader("Tu banco de preguntas")
        show_metrics(stats)
        st.caption("Se muestra el último resultado guardado de cada pregunta. No es una predicción de la nota del examen.")
        weak = ranked_topics(topic_statistics(questions, progress, "gcp_topics"), "Más fallos primero", 5)
        weak = weak[weak["gap"] > 0]
        if not weak.empty:
            st.subheader("Un tema para tu próximo repaso")
            topic = weak.iloc[0]["topic"]
            st.write(topic)
            st.caption("Basado en tus últimos resultados. Con pocas preguntas, esta recomendación es orientativa.")
            if st.button("Practicar este tema", icon=":material/target:"):
                st.session_state.practice_topic_request = topic
                st.switch_page(QUIZ_PAGE)
        else:
            st.info("Los temas que necesiten repaso aparecerán aquí cuando guardes tus primeras respuestas.")
        with st.expander("Datos y reinicio"):
            st.write("Esta instalación es para un único estudiante. Otros navegadores comparten el mismo historial local.")
            st.download_button(
                "Descargar copia del progreso",
                data=json.dumps(progress, ensure_ascii=False, indent=2),
                file_name="progreso-pmle.json", mime="application/json",
            )
            st.caption("El reinicio borra el historial guardado, no las preguntas. Se conserva una copia de seguridad.")
            if st.session_state.quiz_in_progress:
                st.info("Guarda o descarta la ronda pendiente en Práctica antes de reiniciar el historial.")
            else:
                confirmed = st.checkbox("Quiero borrar mi historial guardado", key="confirm_reset")
                if st.button("Reiniciar historial", disabled=not confirmed or not progress):
                    reset_history()
                    st.session_state.pop("confirm_reset", None)
                    st.session_state.message = "Historial reiniciado. Se conserva una copia del archivo anterior."
                    st.rerun()
    except DataError as error:
        st.error(str(error))


def show_dashboard():
    setup_page("Progreso")
    page_heading("Progreso", "Detecta qué repasar. Los datos reflejan el último resultado guardado, no todos tus intentos.")
    try:
        questions, progress = load_questions(), load_progress()
        stats = catalog_stats(questions, progress)
        show_metrics(stats)
        st.caption("Una pregunta con varias etiquetas participa en varios temas. Los porcentajes no equivalen a preparación para el examen.")
        field_label = st.selectbox("Analizar por", list(TOPIC_FIELDS))
        field = TOPIC_FIELDS[field_label]
        view = st.radio("Vista", ["Qué repasar", "Contenido del banco"], horizontal=True)
        if view == "Contenido del banco":
            show_topic_distribution(questions, field)
        else:
            show_knowledge_gaps(field, questions, progress)
        return stats
    except DataError as error:
        st.error(str(error))
        return None


def show_topic_distribution(questions=None, field="gcp_topics"):
    questions = load_questions() if questions is None else questions
    topics = [topic for q in questions for topic in set(getattr(q, field))]
    st.subheader("Contenido del banco")
    if not topics:
        st.info("No hay etiquetas disponibles para esta categoría.")
        return
    stats = pd.Series(topics).value_counts().rename_axis("Tema").reset_index(name="Preguntas")
    limit = st.select_slider("Temas a mostrar", [5, 10, 20, 40], value=10)
    selected = stats.head(limit)
    chart = px.bar(selected.iloc[::-1], x="Preguntas", y="Tema", orientation="h", color_discrete_sequence=["#27856b"])
    chart.update_layout(height=max(300, 30 * len(selected) + 100), margin=dict(l=0, r=20, t=20, b=0))
    st.plotly_chart(chart, theme="streamlit", width="stretch", key=f"distribution_{field}")
    with st.expander("Ver datos del gráfico"):
        st.dataframe(selected, hide_index=True, width="stretch")


def show_knowledge_gaps(topic_field="gcp_topics", questions=None, progress=None):
    questions = load_questions() if questions is None else questions
    progress = load_progress() if progress is None else progress
    stats = topic_statistics(questions, progress, topic_field)
    st.subheader("Qué repasar")
    if stats.empty:
        st.info("Todavía no hay resultados con etiquetas en esta categoría. Guarda una ronda para empezar.")
        return
    with st.expander("Ajustar el análisis"):
        c1, c2 = st.columns(2)
        minimum = c1.number_input("Mínimo de preguntas por tema", min_value=1, max_value=int(stats.attempts.max()), value=1, key=f"min_{topic_field}")
        maximum = c2.slider("Precisión máxima (%)", 0, 100, 100, key=f"accuracy_{topic_field}")
        sort_by = st.selectbox("Orden", list(SORTS), key=f"sort_{topic_field}")
        limit = st.select_slider("Límite de temas", [5, 10, 20, 40], value=10, key=f"limit_{topic_field}")
    filtered = stats[(stats.attempts >= minimum) & (stats.accuracy <= maximum / 100)]
    if filtered.empty:
        st.info("Ningún tema coincide. Reduce el mínimo de preguntas o aumenta la precisión máxima.")
        return
    selected = ranked_topics(filtered, sort_by, limit)
    chart_data = selected.iloc[::-1].copy()
    chart_data["Fallos (%)"] = chart_data.gap * 100
    chart = px.bar(
        chart_data, x="Fallos (%)", y="topic", orientation="h",
        labels={"topic": "Tema", "attempts": "Preguntas", "correct": "Aciertos"},
        hover_data=["attempts", "correct"], color_discrete_sequence=["#27856b"],
    )
    chart.update_layout(height=max(300, 30 * len(selected) + 100), margin=dict(l=0, r=20, t=20, b=0))
    chart.update_xaxes(range=[0, 100])
    st.plotly_chart(chart, theme="streamlit", width="stretch", key=f"gaps_{topic_field}")
    st.caption("Se eligen primero los temas prioritarios y después se ordenan para dibujar el gráfico.")
    table = selected[["topic", "attempts", "correct", "accuracy"]].rename(
        columns={"topic": "Tema", "attempts": "Preguntas", "correct": "Aciertos", "accuracy": "Precisión (%)"}
    )
    table["Precisión (%)"] = (table["Precisión (%)"] * 100).round(1)
    with st.expander("Ver datos del gráfico"):
        st.dataframe(table, hide_index=True, width="stretch")
