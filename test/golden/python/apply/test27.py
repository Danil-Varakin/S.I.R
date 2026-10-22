# [DRIFT] upstream добавил поле в Ticket и строки в Archive.store и dispatch — правка в handle ложится как прежде

import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


@dataclass
class Ticket:
    ident: str
    payload: dict = field(default_factory=dict)
    tries: int = 0
    owner: str = ""


class Queue:
    def __init__(self, limit=100):
        self.limit = limit
        self.items = []

    def size(self):
        return len(self.items)

    def push(self, ticket):
        if self.size() >= self.limit:
            log.warning("очередь переполнена")
            return False
        self.items.append(ticket)
        return True


class Archive:
    def __init__(self):
        self.items = []

    def size(self):
        return len(self.items)

    def store(self, ticket):
        self.items.append(ticket)
        log.info("в архиве %s", ticket.ident)
        return ticket.ident


class Service:
    def __init__(self, queue, archive):
        self.queue = queue
        self.archive = archive
        self.items = []

    def size(self):
        return len(self.items)

    def handle(self, ticket):
        try:
            self.dispatch(ticket)
        except TimeoutError:
            ticket.tries += 1
            if ticket.tries < 3:
                self.queue.push(ticket)
                return None
            log.error("заявка %s исчерпала попытки", ticket.ident)
            return None
        finally:
            log.debug("заявка %s обработана", ticket.ident)
        return self.archive.store(ticket)

    def dispatch(self, ticket):
        for key, value in ticket.payload.items():
            if key == "skip":
                continue
            if value is None:
                raise ValueError(key)
            if key.startswith("_"):
                continue
        return True
