# Experimental Rust port of the live controller (controller-rs/). Build from the repo root:
#   docker build -f controller-rs/Dockerfile -t greenops-controller-rs .
# Run against a fresh READY run (same env block as the JS image; receipt + logs go to /tmp):
#   docker run --rm --read-only --tmpfs /tmp --env-file run.env greenops-controller-rs          # starts the clock
#   docker run --rm --read-only --tmpfs /tmp --env-file run.env greenops-controller-rs --dry    # read-only preview
# Offline self-test under the judging limits (expect "failures 0/20"):
#   docker run --rm --read-only --tmpfs /tmp --user 65534:65534 --cpus 2 --memory 1g greenops-controller-rs mock 20 --lat 3000
# Only challenge/{catalog,rules}.json and the crate's sources enter the build (Dockerfile.dockerignore);
# credentials come from the environment at run time and are never baked in.

FROM rust:1.94-slim@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
WORKDIR /src
# the public catalog and scoring rules are compiled into the binary (single source: challenge/)
COPY challenge/catalog.json challenge/rules.json ./challenge/
COPY controller-rs/Cargo.toml controller-rs/Cargo.lock ./controller-rs/
COPY controller-rs/src ./controller-rs/src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/controller-rs/target \
    cargo build --release --locked --manifest-path controller-rs/Cargo.toml \
 && cp controller-rs/target/release/greenops-controller /greenops-controller

# distroless: glibc + libgcc + CA certificates, no shell; Debian 13 like the builder (same glibc)
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:3ee00291cf386ec52a552e6a858d555debd74776eb4bfa53fa3df2cd6677515e
COPY --from=build /greenops-controller /app/greenops-controller
# receipt + logs go to /tmp, the only writable path in the judging container
ENV GREENOPS_STATE_DIR=/tmp
WORKDIR /tmp
USER 65534:65534
ENTRYPOINT ["/app/greenops-controller"]
