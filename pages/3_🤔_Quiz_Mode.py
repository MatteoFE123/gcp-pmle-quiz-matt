import random
from uuid import uuid4

import streamlit as st

from models.questions import Question
from ui import answer_label, correct_answers, explanation, page_heading, question_content, round_metrics, setup_page
from utils import DataError, load_progress, load_questions
from utils.session import cache_session, finish_round, load_session

STATUS_LABELS = ["Pendientes", "Falladas", "Acertadas"]


def eligible_questions(questions, progress, statuses, topics):
    result = []
    for question in questions:
        status = "Pendientes" if question.id not in progress else ("Acertadas" if progress[question.id] else "Falladas")
        if status in statuses and (not topics or set(topics).intersection(question.gcp_topics)):
            result.append(question)
    return result


def select_questions(questions: list[Question], limit: int, rng=None) -> list[Question]:
    return (rng or random).sample(questions, min(limit, len(questions)))


def persist(**changes):
    previous = {key: st.session_state.get(key) for key in changes}
    st.session_state.update(changes)
    try:
        cache_session()
    except DataError:
        st.session_state.update(previous)
        raise


def clear_memory():
    st.session_state.update(
        quiz_in_progress=False, quizzes=[], quiz_mode_pos=0,
        quiz_mode_round_progress={}, quiz_mode_selections={}, quiz_mode_answered=False,
    )
    for key in list(st.session_state):
        if key.startswith("answer_"):
            del st.session_state[key]


def complete(save: bool):
    finish_round(save)
    clear_memory()
    st.session_state.message = "Resultados guardados en tu progreso." if save else "Ronda descartada. El historial guardado no ha cambiado."


def start_round(questions, limit=None):
    persist(
        round_id=uuid4().hex, quiz_in_progress=True, quizzes=select_questions(questions, len(questions) if limit is None else limit),
        quiz_mode_pos=0, quiz_mode_round_progress={}, quiz_mode_selections={},
        quiz_mode_answered=False,
    )


def run_action(action, *args, **kwargs):
    try:
        action(*args, **kwargs)
    except DataError as error:
        st.session_state.round_action_error = str(error)


def current_selection():
    pos = st.session_state.quiz_mode_pos
    question = st.session_state.quizzes[pos]
    prefix = f"answer_{st.session_state.round_id}_{question.id}"
    if question.mode == "single_choice":
        choice = st.session_state.get(prefix)
        return [] if choice is None else [choice]
    return [i for i in range(len(question.options)) if st.session_state.get(f"{prefix}_{i}", False)]


def remember_selection():
    pos = st.session_state.quiz_mode_pos
    if pos not in st.session_state.quiz_mode_round_progress:
        persist(quiz_mode_selections={**st.session_state.quiz_mode_selections, pos: current_selection()})


def submit_current():
    pos = st.session_state.quiz_mode_pos
    question = st.session_state.quizzes[pos]
    if pos in st.session_state.quiz_mode_round_progress:
        return
    selected = current_selection()
    if not selected:
        st.session_state.round_action_error = "Selecciona al menos una respuesta antes de enviarla."
        return
    persist(
        quiz_mode_round_progress={**st.session_state.quiz_mode_round_progress, pos: set(selected) == set(correct_answers(question))},
        quiz_mode_selections={**st.session_state.quiz_mode_selections, pos: selected},
    )


def show_review():
    quizzes = st.session_state.quizzes
    results = st.session_state.quiz_mode_round_progress
    selections = st.session_state.quiz_mode_selections
    st.subheader("Resumen de la ronda")
    round_metrics(results, len(quizzes))
    st.caption("Los saltos no cuentan como fallos. El historial cambia solo al guardar los resultados.")
    with st.container(horizontal=True):
        st.button("Guardar resultados", type="primary", disabled=not results, on_click=run_action, args=(complete, True))
        unanswered = [pos for pos in range(len(quizzes)) if pos not in results]
        if unanswered:
            st.button("Volver a pendientes", on_click=run_action, args=(persist,), kwargs={"quiz_mode_pos": unanswered[0]})
        with st.popover("Descartar ronda"):
            st.warning("Se perderán las respuestas de esta ronda que no hayas guardado.")
            st.button("Confirmar descarte", key="discard_review", on_click=run_action, args=(complete, False))
    st.subheader("Revisar preguntas")
    for pos, question in enumerate(quizzes):
        state = "Sin responder" if pos not in results else ("Correcta" if results[pos] else "Incorrecta")
        with st.expander(f"{pos + 1}. {state} · Pregunta #{question.id}"):
            st.markdown(question.question, unsafe_allow_html=True)
            if pos in selections:
                st.markdown("**Tu selección**")
                for index in selections[pos]:
                    st.markdown(answer_label(question, index))
            elif pos in results:
                st.caption("Esta ronda antigua conserva el resultado, pero no la selección original.")
            if pos in results:
                explanation(question)
            else:
                st.caption("La explicación se mostrará después de responder.")


def show_quiz():
    questions = st.session_state.quizzes
    pos = st.session_state.quiz_mode_pos
    if pos >= len(questions):
        show_review()
        return
    question = questions[pos]
    results = st.session_state.quiz_mode_round_progress
    answered = pos in results
    st.progress(len(results) / len(questions), text=f"{len(results)} de {len(questions)} preguntas respondidas")
    st.subheader(f"Pregunta {pos + 1} de {len(questions)}")
    st.caption(f"ID {question.id} · {'Respuesta única' if question.mode == 'single_choice' else 'Selección múltiple'}")
    question_content(question)
    saved = st.session_state.quiz_mode_selections.get(pos, [])
    prefix = f"answer_{st.session_state.round_id}_{question.id}"
    with st.container(key="quiz_answers"):
        if question.mode == "single_choice":
            st.session_state.setdefault(prefix, saved[0] if saved else None)
            st.radio(
                "Selecciona una respuesta", range(len(question.options)),
                format_func=lambda index: answer_label(question, index),
                index=None, key=prefix, disabled=answered, on_change=run_action, args=(remember_selection,),
            )
        else:
            st.write("Selecciona todas las respuestas que correspondan.")
            for index in range(len(question.options)):
                key = f"{prefix}_{index}"
                st.session_state.setdefault(key, index in saved)
                st.checkbox(answer_label(question, index), key=key, disabled=answered, on_change=run_action, args=(remember_selection,))
    with st.container(horizontal=True):
        st.button("Comprobar respuesta", type="primary", disabled=answered, key=f"submit_{pos}", on_click=run_action, args=(submit_current,))
        st.button("Siguiente" if answered else "Saltar por ahora", key=f"next_{pos}", on_click=run_action, args=(persist,), kwargs={"quiz_mode_pos": pos + 1})
    if answered:
        if results[pos]:
            st.success("Respuesta correcta.")
        else:
            st.error("Respuesta incorrecta. Revisa la explicación antes de continuar.")
            if saved:
                st.markdown("**Tu respuesta enviada**")
                for index in saved:
                    st.markdown(answer_label(question, index))
        if pos not in st.session_state.quiz_mode_selections:
            st.caption("Ronda antigua: el resultado se conserva, pero no se guardó la selección original.")
        with st.container(border=True):
            explanation(question)
    st.divider()
    with st.container(horizontal=True):
        st.button("Ver resumen", icon=":material/checklist:", on_click=run_action, args=(persist,), kwargs={"quiz_mode_pos": len(questions)})
        with st.popover("Pausar o terminar", icon=":material/pause:"):
            st.write("Puedes salir de esta página: la ronda queda guardada para continuar. El historial se actualiza al guardar resultados.")
            st.button("Guardar y terminar", disabled=not results, on_click=run_action, args=(complete, True))
            st.button("Descartar sin guardar", on_click=run_action, args=(complete, False))
        with st.popover("Reiniciar ronda", icon=":material/restart_alt:"):
            st.warning("Se borrarán las respuestas de esta ronda. El historial guardado no cambia.")
            st.button("Confirmar reinicio", on_click=run_action, args=(start_round, questions))


def show_setup():
    questions, progress = load_questions(), load_progress()
    st.subheader("Prepara una sesión")
    st.write("Elige qué repasar. Las preguntas se mezclan sin repetirse dentro de la ronda.")
    topics = sorted({topic for question in questions for topic in question.gcp_topics})
    requested = st.session_state.pop("practice_topic_request", None)
    if requested:
        st.session_state.practice_topics = [requested] if requested in topics else []
        st.session_state.practice_statuses = STATUS_LABELS[:]
    with st.container(border=True):
        statuses = st.multiselect(
            "Estado de las preguntas", STATUS_LABELS, default=["Pendientes"], key="practice_statuses",
            help="Puedes combinar pendientes, falladas y acertadas de forma independiente.",
        )
        selected_topics = st.multiselect("Temas GCP (opcional)", topics, key="practice_topics", placeholder="Todos los temas")
        length = st.select_slider("Preguntas por ronda", [10, 20, 40, "Todas"], value=20)
        candidates = eligible_questions(questions, progress, statuses, selected_topics)
        count = len(candidates) if length == "Todas" else min(length, len(candidates))
        st.caption(f"{len(candidates)} preguntas disponibles. Esta ronda tendrá {count}.")
        if not candidates:
            st.info("No hay preguntas con esta selección. Añade otro estado o elimina el filtro de temas.")
        st.button("Empezar ronda", type="primary", disabled=not candidates, icon=":material/play_arrow:", on_click=run_action, args=(start_round, candidates, count))
    st.caption("Uso local para un estudiante. Si otra pestaña modifica la ronda, se avisará del conflicto en vez de sobrescribirla.")


def main():
    setup_page("Práctica")
    page_heading("Práctica", "Una pregunta cada vez. Entiende la respuesta y decide qué repasar.")
    if error := st.session_state.pop("round_action_error", None):
        st.error(error)
    try:
        load_session()
        if st.session_state.quiz_in_progress and st.session_state.quizzes:
            if st.session_state.get("practice_topic_request"):
                st.info("Tienes una ronda pendiente. Termínala o descártala para preparar el tema solicitado.")
            show_quiz()
        else:
            show_setup()
    except DataError as error:
        st.error(str(error))
        st.info("No se ha descartado tu ronda. Si otra pestaña la cambió, recarga esta página para recuperar su última versión.")


if __name__ == "__main__":
    main()
