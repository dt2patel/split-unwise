import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandConflictError, CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore, type LocalReceiptReference } from '../../../data/receipts'
import { appPrincipalKey, createAppSession, getAppSession, setAppSessionForTesting } from '../../../data/session'
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

  it('locks the exact failed body and attachments so Retry cannot replay different visible intent', async () => {
    const repository = createDemoRepository()
    const receipts = createMemoryReceiptStore({ id: () => 'locked-comment-file' })
    let attempts = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.add': async (command) => {
        if (command.kind !== 'comment.add') throw new Error('Wrong command')
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('offline'), { code: 'unavailable' })
        return repository.comments.add(command)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receipts }), queue, receipts })
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['photo'], 'locked.jpg', { type: 'image/jpeg' })] })
    await input.trigger('change')
    await wrapper.get('textarea').setValue('Immutable failed comment')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
    expect(wrapper.get('input[type="file"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="remove-comment-attachment"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Retry sends exactly this text and these attachments')
    expect(queue.snapshot()[0]?.envelope).toMatchObject({ body: 'Immutable failed comment', attachmentRefs: ['local-receipt:locked-comment-file'] })

    await wrapper.get('[data-action="retry-comment"]').trigger('click')
    await vi.waitFor(async () => {
      const saved = await repository.comments.listForExpense('lake-house-weekend', 'groceries')
      expect(saved.find(({ body }) => body === 'Immutable failed comment')).toMatchObject({ attachmentRefs: ['local-receipt:locked-comment-file'] })
    })
  })

  it('offers an explicit recovery from a conflicted comment add instead of a disabled deadlock', async () => {
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.add': async () => { throw new CommandConflictError('Comment target changed') } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    await wrapper.get('textarea').setValue('Conflicted draft')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(queue.snapshot()[0]?.status).toBe('conflicted')
    expect(wrapper.get('[data-action="discard-comment-conflict"]').text()).toContain('Discard')
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
    await wrapper.get('[data-action="discard-comment-conflict"]').trigger('click')
    await flushPromises()
    expect(queue.snapshot()).toEqual([])
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(false)
  })

  it('recovers from a pre-queue attachment claim failure and lets the attachment be removed by filename', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'comment-photo' })
    let reference: LocalReceiptReference | undefined
    const capture = {
      ...receipts,
      async put(blob: Blob, metadata: { readonly fileName: string }) {
        reference = await receipts.put(blob, metadata)
        return reference
      },
    }
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts: capture }))
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['photo'], 'groceries.jpg', { type: 'image/jpeg' })] })
    await input.trigger('change')
    await flushPromises()
    if (!reference) throw new Error('Expected captured receipt reference')
    await receipts.delete(reference)

    await wrapper.get('textarea').setValue('Receipt attached')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="comment-error"]').text()).toContain('no longer available')
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(false)
    expect(wrapper.text()).toContain('groceries.jpg')
    expect(wrapper.text()).not.toContain(reference)
    expect(getAppSession().queue.snapshot()).toEqual([])
    await wrapper.get('[data-action="remove-comment-attachment"]').trigger('click')
    expect(wrapper.text()).not.toContain('groceries.jpg')
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

  it('rehydrates an exact failed comment deletion and suppresses duplicate delete commands', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T20:00:00.000Z' })
    const added = await repository.comments.add({ kind: 'comment.add', operationId: 'delete-recovery-source', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Delete me once', attachmentRefs: [] })
    if (added.status !== 'saved') throw new Error('Expected save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.delete': async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    await first.get(`[data-comment-id="${added.comment.commentId}"] [data-action="delete-comment"]`).trigger('click')
    await flushPromises()
    first.unmount()

    const recreated = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    const row = recreated.get(`[data-comment-id="${added.comment.commentId}"]`)
    expect(row.attributes('data-sync-state')).toBe('failed')
    expect(row.find('[data-action="delete-comment"]').exists()).toBe(false)
    expect(row.get('[data-action="retry-comment-delete"]').text()).toBe('Retry delete')
    expect(row.get('[data-action="discard-comment-delete"]').text()).toBe('Discard')
    expect(queue.snapshot().filter(({ envelope }) => envelope.kind === 'comment.delete')).toHaveLength(1)
  })

  it('rehydrates a conflicted comment deletion and resolves it by reloading the durable remote comment', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T20:00:00.000Z' })
    const added = await repository.comments.add({ kind: 'comment.add', operationId: 'conflict-source', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Remote comment wins', attachmentRefs: [] })
    if (added.status !== 'saved') throw new Error('Expected save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.delete': async () => { throw new CommandConflictError('Comment changed remotely', { commentId: added.comment.commentId }) } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    await first.get(`[data-comment-id="${added.comment.commentId}"] [data-action="delete-comment"]`).trigger('click')
    await flushPromises()
    first.unmount()

    const recreated = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    expect(recreated.get(`[data-comment-id="${added.comment.commentId}"]`).attributes('data-sync-state')).toBe('conflicted')
    await recreated.get('[data-action="resolve-comment-delete-conflict"]').trigger('click')
    await flushPromises()
    expect(queue.snapshot()).toEqual([])
    expect(recreated.find(`[data-comment-id="${added.comment.commentId}"] [data-action="delete-comment"]`).exists()).toBe(true)
  })

  it('keeps a comment-delete conflict durable when reloading the repository fails', async () => {
    const source = createDemoRepository({ now: () => '2026-08-31T20:00:00.000Z' })
    const added = await source.comments.add({ kind: 'comment.add', operationId: 'reload-failure-source', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Still remote', attachmentRefs: [] })
    if (added.status !== 'saved') throw new Error('Expected save')
    let failReload = false
    const repository = {
      ...source,
      comments: {
        ...source.comments,
        async listForExpense(groupId: string, expenseId: string) {
          if (failReload) throw new Error('Reload failed remotely')
          return source.comments.listForExpense(groupId, expenseId)
        },
      },
    }
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.delete': async () => { throw new CommandConflictError('Comment changed remotely') } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'groceries', closed: false } })
    await flushPromises()
    await wrapper.get(`[data-comment-id="${added.comment.commentId}"] [data-action="delete-comment"]`).trigger('click')
    await flushPromises()
    failReload = true

    await wrapper.get('[data-action="resolve-comment-delete-conflict"]').trigger('click')
    await flushPromises()
    expect(queue.snapshot()[0]?.status).toBe('conflicted')
    expect(wrapper.get('[data-testid="comment-error"]').text()).toContain('Reload failed remotely')
    expect(wrapper.find('[data-action="resolve-comment-delete-conflict"]').exists()).toBe(true)
  })

  it('keeps prior comments visible while closing the composer on a deleted expense', async () => {
    const wrapper = mount(CommentThread, { props: { groupId: 'lake-house-weekend', expenseId: 'cabin-deposit', closed: true } })
    await flushPromises()

    expect(wrapper.get('[data-testid="comment-list"]').text()).toContain('Perfect, thank you!')
    expect(wrapper.text()).toContain('Comments are closed')
    expect(wrapper.find('form').exists()).toBe(false)
  })
})
