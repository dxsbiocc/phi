import assert from 'node:assert/strict'
import test from 'node:test'
import { describeWebLink } from '../src/renderer/src/lib/markdownWebLinks'

test('raw GitHub repository URLs display the owner and repository name', () => {
  const href = 'https://github.com/mattpocock/skills'

  assert.deepEqual(describeWebLink(href, href), {
    site: 'github',
    label: 'mattpocock/skills'
  })
})

test('GitHub www URLs receive the same repository presentation', () => {
  const href = 'https://www.github.com/mattpocock/skills'

  assert.deepEqual(describeWebLink(href, href), {
    site: 'github',
    label: 'mattpocock/skills'
  })
})

test('GitHub clone URLs omit the .git suffix from the display name', () => {
  const href = 'https://github.com/mattpocock/skills.git'

  assert.equal(describeWebLink(href, href)?.label, 'mattpocock/skills')
})

test('deep GitHub repository URLs display the repository name', () => {
  const href = 'https://github.com/mattpocock/skills/blob/main/README.md?plain=1#setup'

  assert.equal(describeWebLink(href, href)?.label, 'mattpocock/skills')
})

test('explicit GitHub link labels remain unchanged', () => {
  assert.deepEqual(
    describeWebLink('https://github.com/mattpocock/skills', 'Install these skills'),
    {
      site: 'github',
      label: 'Install these skills'
    }
  )
})

test('malformed percent encoding in GitHub names retains the raw URL label', () => {
  for (const path of ['mattpocock%ZZ/skills', 'mattpocock/skills%E0%A4%A']) {
    const href = `https://github.com/${path}`

    assert.equal(describeWebLink(href, href)?.label, href)
  }
})

test('encoded path separators in GitHub repository names retain the raw URL label', () => {
  for (const path of ['mattpocock/skills%2Fother', 'mattpocock/skills%5Cother']) {
    const href = `https://github.com/${path}`

    assert.equal(describeWebLink(href, href)?.label, href)
  }
})

test('encoded control characters in GitHub names retain the raw URL label', () => {
  for (const path of ['mattpocock%0A/skills', 'mattpocock/skills%00', 'mattpocock/skills%7F']) {
    const href = `https://github.com/${path}`

    assert.equal(describeWebLink(href, href)?.label, href)
  }
})

for (const path of [
  '',
  'mattpocock',
  'settings/profile',
  'features/copilot',
  'orgs/openai',
  'topics/typescript',
  'login/search',
  'search/repositories'
]) {
  test(`GitHub non-repository route /${path} retains its URL label`, () => {
    const href = `https://github.com/${path}`

    assert.equal(describeWebLink(href, href)?.label, href)
  })
}

for (const href of [
  'https://github.com.example.org/mattpocock/skills',
  'https://notgithub.com/mattpocock/skills',
  'https://github.com@evil.example/mattpocock/skills'
]) {
  test(`lookalike URL ${href} does not receive GitHub branding`, () => {
    assert.deepEqual(describeWebLink(href, href), { site: 'web', label: href })
  })
}

test('ordinary website links preserve their explicit display text', () => {
  assert.deepEqual(describeWebLink('https://example.com/docs', 'Phi docs'), {
    site: 'web',
    label: 'Phi docs'
  })
})

test('website links fall back to the destination when no display text is provided', () => {
  const href = 'https://example.com/docs?lang=zh#setup'

  assert.deepEqual(describeWebLink(href, ''), { site: 'web', label: href })
})

for (const href of [
  'javascript:alert(1)',
  'file:///tmp/report.html',
  'ssh://cluster-a/data/project/report.txt',
  'mailto:user@example.com',
  './docs/report.html',
  'not a URL'
]) {
  test(`non-web destination ${href} has no web-link presentation`, () => {
    assert.equal(describeWebLink(href, href), null)
  })
}
