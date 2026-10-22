// [INSERT] новая ветка type switch перед default
package sched

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type State int

const (
	StateIdle State = iota
	StateBusy
	StateDone
)

type Job interface {
	Run(ctx context.Context) error
	Name() string
}

type Pool[T Job] struct {
	mu      sync.Mutex
	jobs    []T
	state   State
	timeout time.Duration
}

func NewPool[T Job](timeout time.Duration) *Pool[T] {
	return &Pool[T]{
		jobs:    make([]T, 0, 16),
		state:   StateIdle,
		timeout: timeout,
	}
}

func (p *Pool[T]) Add(job T) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.jobs = append(p.jobs, job)
}

func (p *Pool[T]) Run(ctx context.Context) (int, error) {
	done := make(chan error, len(p.jobs))
	for _, job := range p.jobs {
		go func(j T) {
			done <- j.Run(ctx)
		}(job)
	}

	completed := 0
	for range p.jobs {
		select {
		case err := <-done:
			if err != nil {
				return completed, fmt.Errorf("job failed: %w", err)
			}
			completed++
		case <-ctx.Done():
			return completed, ctx.Err()
		}
	}
	return completed, nil
}

func describe(x any) string {
	switch v := x.(type) {
	case State:
		return fmt.Sprintf("state %d", int(v))
	case error:
		return v.Error()
	case string:
		return v
	default:
		return "unknown"
	}
}
