import streamlit as st

from ui import answer_label, correct_answers, page_heading, setup_page
from utils import DataError, load_progress, load_quizzes

SCOPES = {
    "Preguntas falladas": (0, "preguntas-falladas.md"),
    "Preguntas pendientes": (1, "preguntas-pendientes.md"),
    "Preguntas acertadas": (2, "preguntas-acertadas.md"),
}


def export_markdown(questions, title, include_explanations=True):
    lines = [f"# {title}", "", "Material de repaso personal. El contenido conserva su idioma original.", ""]
    for question in questions:
        lines.extend([f"## Pregunta #{question.id}", "", question.question, "", "### Opciones", ""])
        lines.extend(answer_label(question, index) for index in range(len(question.options)))
        lines.extend(["", "### Respuesta correcta", ""])
        lines.extend(answer_label(question, index) for index in correct_answers(question))
        if include_explanations and question.explanation:
            lines.extend(["", "### Explicación", "", question.explanation])
        lines.extend(["", "---", ""])
    return "\n".join(lines)


def export_false_questions():
    questions, _, _ = load_quizzes(load_progress())
    return export_markdown(questions, "Preguntas falladas")


def main():
    setup_page("Exportar")
    page_heading("Exportar para repasar", "Descarga solo las preguntas que necesitas. No se envía nada a un servicio externo.")
    try:
        scope = st.selectbox("Contenido", list(SCOPES))
        include = st.checkbox("Incluir explicaciones", value=True)
        index, filename = SCOPES[scope]
        questions = load_quizzes(load_progress())[index]
        st.metric("Preguntas en el archivo", len(questions))
        if not questions:
            st.info("No hay preguntas en este grupo. Elige otro o guarda una ronda.")
            return
        st.info("Antes de subir el archivo a NotebookLM u otro servicio, comprueba los permisos del contenido y su política de privacidad.")
        content = export_markdown(questions, scope, include)
        st.download_button("Descargar Markdown", data=content, file_name=filename, mime="text/markdown", type="primary")
        st.caption("El archivo incluye preguntas y respuestas, no tu archivo de progreso. Las imágenes locales pueden no estar disponibles fuera de la aplicación.")
        with st.expander("Vista previa de la primera pregunta"):
            st.code(export_markdown(questions[:1], scope, include), language="markdown", wrap_lines=True)
        with st.expander("Cómo usarlo para repasar"):
            st.write("Si tienes permiso, añade el archivo a tu herramienta de estudio. Pide preguntas nuevas sobre los mismos conceptos y contrasta las respuestas con documentación oficial.")
    except DataError as error:
        st.error(str(error))


if __name__ == "__main__":
    main()
