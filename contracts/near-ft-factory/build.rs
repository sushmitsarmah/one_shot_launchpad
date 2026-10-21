fn main() {
    let p = std::path::Path::new("res/near_ft_token.wasm");
    println!("cargo:rerun-if-changed=res/near_ft_token.wasm");
    if !p.exists() {
        panic!(
            "contracts/near-ft-factory/res/near_ft_token.wasm is missing. \
             Run `bun run contracts:build` (or scripts/build-contracts.sh) first; \
             it builds near-ft-token and copies its wasm here."
        );
    }
}
