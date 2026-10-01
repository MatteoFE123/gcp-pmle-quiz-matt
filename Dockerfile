FROM ghcr.io/astral-sh/uv:0.11.27-python3.13-trixie

WORKDIR /app

COPY pyproject.toml uv.lock /app/
RUN uv sync --locked --no-dev
COPY . /app
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8501

HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8501/_stcore/health', timeout=5)"

CMD ["streamlit", "run", "🏠_Dashboard.py"]
