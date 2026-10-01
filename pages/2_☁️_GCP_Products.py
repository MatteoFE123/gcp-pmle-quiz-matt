import json
import logging
import re

import pandas as pd
import streamlit as st

from ui import page_heading, setup_page
from utils import DATA_DIR, DataError

logger = logging.getLogger(__name__)


def load_data():
    path = DATA_DIR / "gcp_products.jsonl"
    try:
        with path.open(encoding="utf-8") as source:
            rows = [json.loads(line) for line in source if line.strip()]
        names = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("product_name"), str) or not row["product_name"].strip():
                raise ValueError("Nombre de producto inválido")
            if row["product_name"] in names:
                raise ValueError("Producto duplicado")
            names.add(row["product_name"])
            for field in ["ui", "connected_to", "use_cases", "not_used_when"]:
                value = row.get(field, [])
                if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                    raise ValueError("Lista de producto inválida")
            for field in ["entity_type", "short_description"]:
                if not isinstance(row.get(field, ""), str):
                    raise ValueError("Descripción de producto inválida")
        return rows
    except (OSError, ValueError) as error:
        logger.error("No se pudo cargar el catálogo de productos: %s", type(error).__name__)
        raise DataError("No se pudo leer el catálogo de productos. Comprueba data/gcp_products.jsonl y sus permisos.") from error


def normalize_token(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def capability_matrix(rows):
    dependencies = sorted({normalize_token(value) for row in rows for value in row.get("connected_to", [])})
    return pd.DataFrame([
        {"Producto": row["product_name"], **{dependency: dependency in {normalize_token(v) for v in row.get("connected_to", [])} for dependency in dependencies}}
        for row in rows
    ]).set_index("Producto")


def show_list(title, values):
    st.markdown(f"#### {title}")
    if values:
        for value in values:
            st.markdown(f"- {value}")
    else:
        st.caption("No hay información registrada.")


def main():
    setup_page("Productos")
    page_heading("Productos de Google Cloud", "Consulta cuándo usar cada servicio y compara sus conexiones.")
    try:
        rows = load_data()
        if not rows:
            st.info("El catálogo de productos está vacío.")
            return
        query = st.text_input("Buscar un producto", placeholder="Nombre o descripción")
        names = sorted(row["product_name"] for row in rows)
        focused = st.multiselect("Productos a mostrar", names, placeholder="Todos los productos")
        filtered = [
            row for row in rows
            if (not focused or row["product_name"] in focused)
            and query.casefold() in f"{row['product_name']} {row.get('short_description', '')}".casefold()
        ]
        st.caption(f"{len(filtered)} de {len(rows)} productos")
        if not filtered:
            st.info("No hay coincidencias. Borra la búsqueda o cambia los productos seleccionados.")
            return
        view = st.radio("Vista", ["Ficha", "Conexiones"], horizontal=True)
        if view == "Conexiones":
            matrix = capability_matrix(filtered)
            if matrix.empty or len(matrix.columns) == 0:
                st.info("Estos productos no tienen conexiones registradas.")
                return
            counts = matrix.sum(axis=0).sort_values(ascending=False)
            maximum = min(50, len(counts))
            limit = st.number_input("Conexiones a mostrar", min_value=1, max_value=maximum, value=min(10, maximum))
            st.caption("Cada fila es un producto. Una casilla marcada indica una conexión registrada, no una obligación de usar ambos servicios.")
            st.dataframe(matrix[counts.index[:limit]], width="stretch")
            st.subheader("Conexiones más compartidas")
            shared = counts.head(limit).rename_axis("Conexión").reset_index(name="Productos conectados")
            st.dataframe(shared, hide_index=True, width="stretch")
        else:
            available = sorted(row["product_name"] for row in filtered)
            if st.session_state.get("product_detail") not in available:
                st.session_state.product_detail = available[0]
            choice = st.selectbox("Producto", available, key="product_detail")
            row = next(row for row in filtered if row["product_name"] == choice)
            with st.container(border=True):
                st.subheader(row["product_name"])
                st.write(row.get("short_description", ""))
                if row.get("entity_type"):
                    st.caption(row["entity_type"])
                c1, c2 = st.columns(2)
                with c1:
                    show_list("Cuándo usarlo", row.get("use_cases", []))
                with c2:
                    show_list("Cuándo no usarlo", row.get("not_used_when", []))
            with st.expander("Acceso y conexiones"):
                show_list("Formas de acceso", row.get("ui", []))
                show_list("Conectado con", row.get("connected_to", []))
    except DataError as error:
        st.error(str(error))


if __name__ == "__main__":
    main()
