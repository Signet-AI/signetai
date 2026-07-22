#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

namespace SignetRecallRequest
{
inline constexpr int32 DefaultNpcLimit = 6;
inline constexpr int32 MinimumNpcLimit = 1;
inline constexpr int32 MaximumNpcLimit = 20;

TSharedRef<FJsonObject> BuildNpcBody(
	const FString& AgentId,
	const FString& Scope,
	const FString& Query,
	int32 Limit
);
}
