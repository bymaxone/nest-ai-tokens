# The images the end-to-end suites start, pinned by digest. This file is never built: it is the one place
# that names them. The Testcontainers fixtures read it, the workflows pre-pull from it, and Dependabot's
# docker ecosystem bumps the tag and the digest here together. Each digest is the multi-architecture index,
# so the same pin resolves on an amd64 runner and on an arm64 workstation.
FROM postgres:16@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657 AS postgres
FROM redis:7@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90 AS redis
