# [ELLIPSISANN] Ellipsis как ТИП: Callable[ ..., None] — оператор Sir отдельным словом
from typing import Callable

Sink = Callable[ ..., bool]


def wire(sink: Sink) -> None:
    sink(1)
