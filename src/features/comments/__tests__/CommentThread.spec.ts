import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import CommentThread from '../CommentThread.vue'

const principalKey = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' })

beforeEach(() => {
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})

describe('comment thread', () => {
  it('renders a labelled chronological list with valid times and author-only delete actions', async () => {
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'cabin-deposit', closed: false } })
    await flushPromises()

    const comments = wrapper.get('[data-testid="comment-list"]')
    expect(comments.attributes('aria-labelledby')).toBe('comments-title')
    expect(comments.findAll('li')).toHaveLength(2)
    expect(comments.findAll('time').every((time) => time.attributes('datetime')?.endsWith('Z'))).toBe(true)
    expect(comments.findAll('[data-action="delete-comment"]')).toHaveLength(1)
  })

  it('trims and saves a comment through the app queue without duplicating its projection', async () => {
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()

    await wrapper.get('textarea').setValue('  Bring bags.  ')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Comment saved'))

    const matching = wrapper.findAll('[data-comment-id]').filter((item) => item.text().includes('Bring bags.'))
    expect(matching).toHaveLength(1)
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
    expect(wrapper.get('[role="status"]').text()).toContain('Comment saved')
  })

  it('rejects a blank body with a focused error summary and no queue write', async () => {
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    const summary = wrapper.get('[data-testid="comment-error"]')
    const summaryElement = summary.element as HTMLElement
    const focus = summaryElement.focus.bind(summaryElement)
    let focused = false
    summaryElement.focus = () => { focused = true; focus() }

    await wrapper.get('textarea').setValue('   ')
    await wrapper.get('form').trigger('submit')

    expect(summary.text()).toContain('Enter a comment')
    expect(focused).toBe(true)
    expect(wrapper.findAll('[data-comment-id]')).toHaveLength(0)
  })

  it('preserves a failed draft and exposes durable retry and discard actions', async () => {
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.add': async () => { const error = new Error('offline'); Object.assign(error, { code: 'unavailable' }); throw error } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()

    await wrapper.get('textarea').setValue('Keep this draft')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('textarea').element).toHaveProperty('value', 'Keep this draft')
    expect(wrapper.get('[data-testid="comment-error"]').text()).toContain('failed')
    expect(wrapper.get('[data-action="retry-comment"]').text()).toBe('Retry')
    await wrapper.get('[data-action="discard-comment"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
    expect(queue.snapshot()).toEqual([])
  })

  it('projects one durable pending comment and restores its draft after component recreation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.add': async (command) => {
        if (command.kind !== 'comment.add') throw new Error('Wrong command')
        await gate
        return repository.comments.add(command)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()

    await first.get('textarea').setValue('Durable pending note')
    void first.get('form').trigger('submit')
    await vi.waitFor(() => expect(queue.snapshot()[0]?.status).toBe('pending'))
    expect(first.findAll('[data-comment-id^="pending:"]')).toHaveLength(1)
    first.unmount()

    const recreated = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    expect(recreated.findAll('[data-comment-id^="pending:"]')).toHaveLength(1)
    expect(recreated.get('textarea').element).toHaveProperty('value', 'Durable pending note')

    release()
    await vi.waitFor(() => expect(queue.snapshot()[0]?.status).toBe('fresh'))
    recreated.unmount()
  })

  it('tombstones the current user comment and never offers editing', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T20:00:00.000Z' })
    const added = await repository.comments.add({ kind: 'comment.add', operationId: 'own-visible-comment', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'My visible note', attachmentRefs: [] })
    if (added.status !== 'saved') throw new Error('Expected save')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()

    const row = wrapper.get(`[data-comment-id="${added.comment.commentId}"]`)
    expect(row.find('[data-action="edit-comment"]').exists()).toBe(false)
    await row.get('[data-action="delete-comment"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get(`[data-comment-id="${added.comment.commentId}"]`).text()).toContain('Comment deleted'))

    expect(wrapper.get(`[data-comment-id="${added.comment.commentId}"]`).text()).toContain('Comment deleted')
  })

  it('keeps prior comments visible while closing the composer on a deleted expense', async () => {
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'cabin-deposit', closed: true } })
    await flushPromises()

    expect(wrapper.get('[data-testid="comment-list"]').text()).toContain('Perfect, thank you!')
    expect(wrapper.text()).toContain('Comments are closed')
    expect(wrapper.find('form').exists()).toBe(false)
  })
})
