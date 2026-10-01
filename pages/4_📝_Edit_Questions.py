import streamlit as st
from pydantic import ValidationError

from models.questions import Question
from ui import answer_label, correct_answers, explanation, page_heading, question_content, setup_page
from utils import DataError, load_questions, save_question


def main():
    setup_page("Editar preguntas")
    page_heading("Editar preguntas", "Herramienta local de mantenimiento. Cambia la respuesta y explicación sin alterar el identificador.")
    try:
        questions = load_questions()
        lookup = {question.id: question for question in questions}
        editing = st.session_state.get("editor_original")
        if st.session_state.get("editor_id") not in lookup:
            st.session_state.editor_id = questions[0].id
        selected = st.selectbox("Pregunta por identificador", list(lookup), key="editor_id", disabled=editing is not None)
        question = editing if editing is not None else lookup[selected]
        st.caption(f"Pregunta #{question.id} · {'Respuesta única' if question.mode == 'single_choice' else 'Selección múltiple'}")
        question_content(question)
        if editing is None:
            for index in range(len(question.options)):
                st.markdown(answer_label(question, index))
            with st.expander("Respuesta y explicación actuales", expanded=True):
                explanation(question)
            if st.button("Editar esta pregunta", type="primary"):
                st.session_state.editor_original = question.model_copy(deep=True)
                st.rerun()
            st.caption("Las preguntas y explicaciones se mantienen en su idioma original. Los cambios guardados afectan a futuras rondas.")
            return
        st.warning("Guarda o cancela antes de cambiar de página. Los cambios del formulario sin enviar pueden perderse al navegar.")
        with st.form(f"editor_{question.id}"):
            if question.mode == "single_choice":
                answer = st.radio(
                    "Respuesta correcta", range(len(question.options)),
                    index=correct_answers(question)[0],
                    format_func=lambda index: answer_label(question, index),
                )
            else:
                answer = st.multiselect(
                    "Respuestas correctas", range(len(question.options)),
                    default=correct_answers(question),
                    format_func=lambda index: answer_label(question, index),
                )
            text = st.text_area("Explicación", value=question.explanation or "", height=280)
            save = st.form_submit_button("Guardar cambios", type="primary")
            cancel = st.form_submit_button("Cancelar edición")
        if cancel:
            del st.session_state.editor_original
            st.rerun()
        if save:
            try:
                updated = Question.model_validate({**question.model_dump(), "answer": answer, "explanation": text})
            except ValidationError:
                st.error("Selecciona una respuesta válida. La selección múltiple necesita al menos una opción.")
                return
            save_question(updated, original=question)
            del st.session_state.editor_original
            st.session_state.message = "Pregunta guardada. Se conserva una copia de seguridad del banco anterior."
            st.rerun()
    except DataError as error:
        st.error(str(error))
        if st.session_state.get("editor_original") is not None:
            if st.button("Descartar borrador y recargar"):
                del st.session_state.editor_original
                st.rerun()


if __name__ == "__main__":
    main()
