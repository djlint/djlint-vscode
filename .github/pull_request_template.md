<!--
Pull requests are squash-merged, so write the title in the Conventional Commits
style: `fix: ...`, `feat: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `chore: ...`.

CI runs the linters and tests. To catch failures before you push, run:

uvx prek run --all-files
npx oxlint
npm test
-->

## Summary

<!-- What does this change, and why? -->

## Related issues

<!-- `Closes #123` closes the issue on merge. Remove this section if there are none. -->

## Testing

<!-- How did you check that this works? -->

## Checklist

- [ ] New behavior has tests.
- [ ] `CHANGELOG.md` describes any user-visible change under `[Unreleased]`.
- [ ] `package.json` and `README.md` match any change to the settings or commands.
