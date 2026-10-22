class Handler1:
    def register(self, opts):
        if opts.enabled:
            for item in opts.items:
                self.add(item)
    def size(self):
        return 1

class Handler2:
    def register(self, opts):
        if opts.enabled:
            for item in opts.values:
                self.add(item)
    def size(self):
        return 2

class Handler3:
    def register(self, opts):
        if opts.enabled:
            for item in opts.items:
                self.add(item)
    def size(self):
        return 3
