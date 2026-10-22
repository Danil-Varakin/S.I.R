// [DRIFT] upstream добавил поле в Pool и поменял Display — правка в summarize ложится как прежде
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry<'a> {
    pub key: &'a str,
    pub hits: u64,
}

pub trait Backend {
    fn fetch(&self, key: &str) -> Option<Vec<u8>>;

    fn describe(&self) -> String {
        format!("backend with {} keys", self.len())
    }

    fn len(&self) -> usize;
}

pub struct Pool<B: Backend> {
    backend: B,
    entries: HashMap<String, u64>,
    limit: usize,
    misses: u64,
}

impl<B: Backend> Pool<B> {
    pub fn new(backend: B, limit: usize) -> Self {
        Self {
            backend,
            entries: HashMap::new(),
            limit,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        let counter = self.entries.entry(key.to_string()).or_insert(0);
        *counter += 1;
        self.backend.fetch(key)
    }

    pub fn classify(&self, hits: u64) -> &'static str {
        match hits {
            0 => "cold",
            n if n < 10 => "warm",
            1000..=u64::MAX => "hot",
            _ => "normal",
        }
    }
}

impl<'a> fmt::Display for Entry<'a> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} hits", self.key, self.hits)
    }
}

pub fn summarize<I>(items: I) -> Vec<String>
where
    I: IntoIterator<Item = u64>,
{
    items.into_iter().map(|n| format!("{n:>6}")).collect()
}
