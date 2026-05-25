#pragma once

#include "CoreMinimal.h"
#include "SignetUnrealTypes.h"

class FJsonObject;

class SIGNETUNREALRUNTIME_API FSignetUnrealClient
{
public:
	using FJsonResponseHandler = TFunction<void(const FSignetOperationResult& Result, const TSharedPtr<FJsonObject>& Json)>;

	static FString BuildWorldScope(const FString& WorldId);
	static FString BuildPlayerScope(const FString& WorldId, const FString& PlayerId);
	static FString NormalizeBaseUrl(const FString& BaseUrl);
	static FString BuildUrl(const FString& Path);

	static void GetJson(const FString& Path, FJsonResponseHandler Handler);
	static void PostJson(const FString& Path, const TSharedRef<FJsonObject>& Body, FJsonResponseHandler Handler);

private:
	static void SendJsonRequest(
		const FString& Method,
		const FString& Path,
		const FString& Body,
		FJsonResponseHandler Handler
	);
};
