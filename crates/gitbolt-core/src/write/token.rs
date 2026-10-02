/// Proof that the caller is the write pipeline (spec #2 §3.3, Deviation 1). `GitInvocation::write`
/// takes one, and only `crate::write` can mint one, so no read path can build a write. The
/// journal code (`crate::journal`) gets the token `run_write` hands it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WriteToken(());

impl WriteToken {
    pub(in crate::write) fn mint() -> Self {
        Self(())
    }

    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self(())
    }
}
