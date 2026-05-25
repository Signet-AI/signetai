#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "SignetUnrealSettings.generated.h"

UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "Signet Unreal"))
class SIGNETUNREALRUNTIME_API USignetUnrealSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Connection")
	FString DaemonUrl = TEXT("http://127.0.0.1:3850");

	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Connection", meta = (ClampMin = "1.0"))
	float RequestTimeoutSeconds = 10.0f;

	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Connection")
	FString BearerToken;

	virtual FName GetCategoryName() const override;
};
