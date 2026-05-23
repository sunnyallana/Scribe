//! Branded ID newtypes. The TS side uses Zod brands; here we use `serde`
//! transparent wrappers so the wire format stays a plain string/uuid while
//! the type system prevents accidental mixing of e.g. ProjectId and FileId.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! uuid_newtype {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            #[inline]
            pub fn new(value: Uuid) -> Self {
                Self(value)
            }

            #[inline]
            pub fn into_inner(self) -> Uuid {
                self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }

        impl From<$name> for Uuid {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

uuid_newtype!(ProjectId);
uuid_newtype!(FileId);
uuid_newtype!(UserId);
uuid_newtype!(MemberId);
uuid_newtype!(CommentId);
uuid_newtype!(ShareLinkId);
