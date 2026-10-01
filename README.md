# PMLE Study

Aplicación local de Streamlit para preparar Google Cloud Professional Machine Learning Engineer. La interfaz está en español; las preguntas, explicaciones y fichas conservan su idioma original.

## Qué puedes hacer

- **Inicio:** continuar una ronda, preparar una práctica y ver un resumen del progreso.
- **Práctica:** elegir pendientes, falladas o acertadas de forma independiente; filtrar por temas y limitar la ronda a 10, 20, 40 o todas las preguntas disponibles.
- **Repaso:** comprobar respuestas, leer explicaciones, saltar preguntas y volver a las pendientes antes de guardar.
- **Progreso:** consultar los temas prioritarios y los datos que respaldan cada gráfico.
- **Productos:** buscar servicios, consultar usos y comparar conexiones.
- **Herramientas:** editar respuestas y explicaciones o exportar un grupo de preguntas a Markdown.

El banco contiene 841 preguntas y 104 fichas de producto. La precisión muestra el **último resultado guardado por pregunta**, no todos los intentos ni una predicción del examen oficial.

## Instalación local

Necesitas Python 3.10 o posterior y [uv](https://docs.astral.sh/uv/getting-started/installation/). Las comprobaciones de CI incluyen Python 3.10 y 3.13.

Desde PowerShell:

```powershell
git clone https://github.com/MatteoFE123/gcp-pmle-quiz-matt.git
Set-Location gcp-pmle-quiz-matt
uv sync --locked
uv run --locked streamlit run '🏠_Dashboard.py'
```

En Linux o macOS, utiliza `cd gcp-pmle-quiz-matt` en lugar de `Set-Location`. Los demás comandos son iguales. Abre `http://localhost:8501`.

El comando soportado es `streamlit run`; no se instala un comando independiente llamado `quiz`. Las versiones de las dependencias están registradas en `uv.lock`.

## Guardado y recuperación

Esta versión está diseñada para **un estudiante local**, no para publicar un servicio multiusuario. Distintos navegadores comparten historial y ronda. Si dos pestañas intentan modificar una ronda desde versiones distintas, se rechaza el cambio antiguo en vez de sobrescribirlo.

- Las selecciones, respuestas y posición de la ronda se guardan en `cache` para poder continuar después de recargar.
- El historial de `data/progress.json` cambia al pulsar **Guardar resultados** o **Guardar y terminar**.
- **Descartar** elimina la ronda pendiente sin añadir resultados al historial. Los saltos no cuentan como fallos.
- Las respuestas enviadas quedan bloqueadas. Se puede revisar su explicación, pero no cambiar la puntuación de ese envío.
- Desde Inicio puedes descargar una copia del progreso. Para reiniciar el historial, primero guarda o descarta la ronda pendiente y confirma expresamente el borrado.
- Los guardados usan bloqueo, sustitución atómica y una copia anterior `.bak`. El editor rechaza cambios si otra sesión ha modificado la misma pregunta.
- Un archivo de progreso dañado no se interpreta como vacío ni se sobrescribe automáticamente. Detén la aplicación, conserva el archivo y recupera una copia válida antes de volver a arrancar.

Para restaurar una copia, cierra las sesiones y detén la aplicación. Conserva aparte el archivo dañado y copia `progress.json.bak` a `progress.json` o `quizzes.jsonl.bak` a `quizzes.jsonl`, según corresponda. Comprueba el contenido recuperado antes de continuar. La copia `.bak` contiene la versión anterior, no un historial ilimitado.

Las rutas se calculan desde el proyecto, no desde el directorio desde el que se lanza Python. Para pruebas o instalaciones separadas se pueden configurar:

```powershell
$env:QUIZ_DATA_DIR = 'C:\ruta\datos-de-prueba'
$env:QUIZ_CACHE_DIR = 'C:\ruta\cache-de-prueba'
```

Los datos de prueba deben incluir `quizzes.jsonl` y `gcp_products.jsonl`. No apuntes las pruebas a tu historial personal.

## Formato de las preguntas

`data/quizzes.jsonl` contiene un objeto JSON por línea:

```json
{
  "id": 10001,
  "mode": "multiple_choice",
  "question": "Pregunta de ejemplo, no material del examen.",
  "options": ["Opción A", "Opción B", "Opción C"],
  "answer": [0, 2],
  "explanation": "Explicación del ejemplo.",
  "gcp_topics": ["Tema de ejemplo"],
  "gcp_products": ["Producto de ejemplo"],
  "ml_topics": ["Concepto de ejemplo"]
}
```

En `single_choice`, `answer` es un entero. En `multiple_choice`, es una lista no vacía de índices enteros distintos. Los índices empiezan en cero y deben corresponder a opciones existentes. Se exigen IDs únicos y se conservan metadatos adicionales al editar.

Por compatibilidad, las respuestas múltiples antiguas guardadas como entero se convierten **solo en memoria** a una lista, con aviso en el registro. Esto permite abrir el registro antiguo ID 148 sin reescribir el banco ni cambiar su respuesta sustantiva.

El editor conserva una copia del banco y modifica solo la fila elegida. Guarda o cancela antes de cambiar de página: los cambios de un formulario que aún no se ha enviado pueden perderse al navegar. Las rondas existentes conservan una copia de sus preguntas; una edición se aplica a las rondas nuevas.

## Exportaciones y contenido

La exportación distingue preguntas **falladas**, **pendientes** y **acertadas**. El nombre, la cantidad y el contenido del archivo coinciden. Incluir explicaciones es opcional. La descarga no envía datos a NotebookLM ni a ningún otro servicio.

Comprueba los permisos del material y las condiciones de privacidad antes de subirlo a servicios externos. Las imágenes locales no se incluyen como archivos dentro del Markdown. No se afirma que el contenido sea oficial ni que tenga permisos de redistribución resueltos; faltan una revisión de procedencia y una correspondencia experta con el temario actual.

## Docker

```powershell
docker compose up --build -d
```

La configuración publica `http://127.0.0.1:8501` solo en la máquina local. Monta `data` y `cache` para conservar preguntas, progreso y rondas al recrear el contenedor. La imagen no incluye el banco: necesita esos datos externos. No elimines los directorios montados para actualizar.

La construcción usa `uv sync --locked`; el arranque utiliza el entorno ya instalado, sin resolver paquetes. La comprobación de salud utiliza Python, no depende de `curl`. El devcontainer también instala todas las dependencias desde el archivo de versiones.

No expongas esta configuración directamente a Internet: no hay cuentas ni permisos separados para editar preguntas. El acceso remoto requiere un diseño adicional de autenticación y propiedad de datos.

## Comprobaciones

```powershell
uv sync --locked
uv run --locked python -B -m unittest discover -s tests -v
docker compose config --quiet
```

Las pruebas usan datos ficticios y directorios aislados. Comprueban validación, conflictos, copias, recuperación, guardado, navegación, filtros, edición, exportaciones y orden de los gráficos. No leen ni modifican el progreso real.

El plan de mejoras original está en [`_docs/implementation-plan.html`](_docs/implementation-plan.html). Es la fotografía de la auditoría previa, no un indicador automático de lo ya implementado. Se ha elegido renovar Streamlit y corregir los recorridos básicos; cuentas, trabajo sin conexión, repetición espaciada y revisión experta del banco quedan fuera de esta entrega.
