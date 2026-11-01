ChoiceScript regression reference

Repository: https://github.com/dfabulich/choicescript
Commit: 60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a

scene.js and util.js are unmodified copies of web/scene.js and web/util.js
at the commit above. LICENSE.txt is the upstream license at the same commit.
The files are read into isolated Node VM contexts by tests; they are not
included in the PathOS web or iOS application bundles.

Keep these files pinned so the regression suite runs offline and does not
depend on private game packages or changes to the upstream main branch.
