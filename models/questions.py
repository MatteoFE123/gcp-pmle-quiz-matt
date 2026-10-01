from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Question(BaseModel):
    model_config = ConfigDict(strict=True, extra="allow")

    id: int = Field(gt=0)
    mode: Literal["single_choice", "multiple_choice"]
    question: str
    options: list[str] = Field(min_length=1)
    answer: int | list[int]
    explanation: str | None = None
    gcp_topics: list[str] = Field(default_factory=list)
    gcp_products: list[str] = Field(default_factory=list)
    ml_topics: list[str] = Field(default_factory=list)

    @field_validator("question")
    @classmethod
    def question_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("El enunciado no puede estar vacío.")
        return value

    @field_validator("options", "gcp_topics", "gcp_products", "ml_topics")
    @classmethod
    def entries_not_blank(cls, values: list[str]) -> list[str]:
        if any(not value.strip() for value in values):
            raise ValueError("Las opciones y etiquetas no pueden estar vacías.")
        return values

    @model_validator(mode="after")
    def valid_answer(self) -> "Question":
        if self.mode == "single_choice":
            if type(self.answer) is not int:
                raise ValueError("Una pregunta de respuesta única necesita un índice entero.")
            indices = [self.answer]
        else:
            if not isinstance(self.answer, list) or not self.answer:
                raise ValueError("Una pregunta múltiple necesita una lista de respuestas no vacía.")
            indices = self.answer
        if len(set(indices)) != len(indices):
            raise ValueError("Los índices de respuesta no pueden repetirse.")
        if any(index < 0 or index >= len(self.options) for index in indices):
            raise ValueError("Una respuesta hace referencia a una opción inexistente.")
        return self
