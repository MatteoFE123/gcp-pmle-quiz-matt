from pathlib import Path

import streamlit as st

from models.questions import Question
from utils import set_css_style

ROOT = Path(__file__).resolve().parent
QUIZ_PAGE = "pages/3_🤔_Quiz_Mode.py"


def setup_page(title: str):
    st.set_page_config(page_title=f"{title} | PMLE Study", layout="wide")
    set_css_style(ROOT / "style.css")


def page_heading(title: str, description: str):
    st.title(title)
    st.caption(description)
    if message := st.session_state.pop("message", None):
        st.success(message)


def question_content(question: Question):
    with st.container(key="question_content"):
        st.markdown(question.question, unsafe_allow_html=True)


def correct_answers(question: Question) -> list[int]:
    return question.answer if isinstance(question.answer, list) else [question.answer]


def answer_label(question: Question, index: int) -> str:
    return f"{chr(65 + index)}. {question.options[index]}"


def explanation(question: Question):
    st.markdown("#### Respuesta correcta")
    for index in correct_answers(question):
        st.markdown(answer_label(question, index))
    st.markdown("#### Por qué")
    st.markdown(question.explanation or "Esta pregunta todavía no tiene explicación.", unsafe_allow_html=True)


def round_metrics(results: dict[int, bool], total: int):
    correct = sum(results.values())
    cols = st.columns(4)
    cols[0].metric("Respondidas", f"{len(results)} / {total}")
    cols[1].metric("Aciertos", correct)
    cols[2].metric("Fallos", len(results) - correct)
    cols[3].metric("Sin responder", total - len(results))
