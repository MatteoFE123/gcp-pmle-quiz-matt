import streamlit as st

from dashboard import show_dashboard, show_home
from ui import setup_page


def main():
    setup_page("Inicio")
    navigation = st.navigation(
        [
            st.Page(show_home, title="Inicio", icon=":material/home:", default=True),
            st.Page("pages/3_🤔_Quiz_Mode.py", title="Práctica", icon=":material/quiz:", url_path="Quiz_Mode"),
            st.Page(show_dashboard, title="Progreso", icon=":material/bar_chart:", url_path="Progress"),
            st.Page("pages/2_☁️_GCP_Products.py", title="Productos", icon=":material/hub:", url_path="GCP_Products"),
            st.Page("pages/5_🇦🇮_Export_for_LM.py", title="Exportar", icon=":material/download:", url_path="Export_for_LM"),
            st.Page("pages/4_📝_Edit_Questions.py", title="Editar preguntas", icon=":material/edit_note:", url_path="Edit_Questions"),
        ],
        position="top",
    )
    navigation.run()


if __name__ == "__main__":
    main()
